import { createHash } from "node:crypto";

import { buildPermissionJudgeRequest } from "./judge.ts";
import { MAX_SHELL_COMMAND_LENGTH } from "./limits.ts";
import { normalizeExecutableName, parseShellCommand } from "./shell.ts";
import type {
  DecisionCode,
  DeterministicDecisionCode,
  GateConfig,
  GateDecision,
  GateMode,
  KnownHost,
  NormalizedShellAction,
  PermissionAssessment,
  PermissionJudge,
  PermissionJudgeOutcome,
  PermissionJudgeRequest,
  Shell,
  StructuredDenial,
  VerifiedExecutable,
} from "./types.ts";

const MAX_REJECTION_KEYS = 1_024;

const messages: Record<
  Exclude<DecisionCode, "AMG_ALLOW_SAFE_COMMAND" | "AMG_ALLOW_JUDGE">,
  string
> = {
  AMG_DENY_DANGEROUS_COMMAND: "The command matches a deterministic deny rule.",
  AMG_DENY_AMBIGUOUS: "The command could not be classified as safe.",
  AMG_DENY_UNKNOWN_ACTION: "The action type or shell is not supported.",
  AMG_DENY_INVALID_INPUT: "The action input is missing, truncated, or invalid.",
  AMG_DENY_INTERNAL_ERROR: "The action could not be evaluated safely.",
  AMG_DENY_JUDGE: "The permission judge denied the action.",
  AMG_DENY_JUDGE_UNAVAILABLE: "The permission judge is not available.",
  AMG_DENY_JUDGE_TIMEOUT: "The permission judge did not respond before the deadline.",
  AMG_DENY_JUDGE_CANCELLED: "The permission judge request was cancelled.",
  AMG_DENY_JUDGE_INVALID_RESPONSE: "The permission judge returned an invalid response.",
  AMG_DENY_JUDGE_ERROR: "The permission judge could not evaluate the action safely.",
};

const dangerousCommands: Record<Shell, ReadonlySet<string>> = {
  bash: new Set([
    "bash",
    "chmod",
    "chown",
    "chgrp",
    "cp",
    "curl",
    "dd",
    "fish",
    "install",
    "ln",
    "mkdir",
    "mkfs",
    "mv",
    "nc",
    "reboot",
    "rm",
    "rmdir",
    "rsync",
    "scp",
    "sh",
    "shutdown",
    "ssh",
    "su",
    "sudo",
    "tee",
    "touch",
    "truncate",
    "wget",
    "zsh",
  ]),
  powershell: new Set([
    "add-content",
    "clear-content",
    "copy-item",
    "invoke-command",
    "invoke-expression",
    "invoke-restmethod",
    "invoke-webrequest",
    "move-item",
    "new-item",
    "out-file",
    "remove-item",
    "rename-item",
    "set-content",
    "set-item",
    "start-process",
    "stop-computer",
    "stop-process",
  ]),
  cmd: new Set([
    "bitsadmin",
    "call",
    "certutil",
    "cmd",
    "copy",
    "curl",
    "del",
    "erase",
    "format",
    "md",
    "mkdir",
    "move",
    "powershell",
    "rd",
    "ren",
    "rename",
    "rmdir",
    "robocopy",
    "shutdown",
    "start",
    "taskkill",
    "xcopy",
  ]),
};

const safeCommands: Record<Shell, ReadonlySet<string>> = {
  bash: new Set([
    "cat",
    "echo",
    "grep",
    "head",
    "ls",
    "pwd",
    "stat",
    "tail",
    "wc",
    "which",
    "whereis",
  ]),
  powershell: new Set(["where"]),
  cmd: new Set(["find", "findstr", "where"]),
};

const dangerousGitCommands = new Set([
  "add",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
]);
const safeGitCommands = new Set(["rev-parse"]);
const dangerousGitOptions = new Set(["--ext-diff", "--textconv"]);
const dangerousFindOptions = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

type InternalAssessment = PermissionAssessment & {
  readonly code: DeterministicDecisionCode;
  readonly action?: NormalizedShellAction;
  readonly equivalenceInput: string;
};

interface FinalResolution {
  readonly effect: "allow" | "deny";
  readonly code: DecisionCode;
  readonly source: "deterministic" | "judge";
}

interface InputSnapshot {
  readonly kind: unknown;
  readonly tool: unknown;
  readonly shell: unknown;
  readonly command: unknown;
  readonly executable: unknown;
  readonly truncated: unknown;
  readonly host: unknown;
}

export class RejectionTracker {
  readonly #counts = new Map<string, number>();

  record(equivalenceInput: string, code: DecisionCode): number {
    const key = createHash("sha256").update(code).update("\0").update(equivalenceInput).digest("hex");
    const count = (this.#counts.get(key) ?? 0) + 1;

    // Cap session memory; use an LRU only if long sessions need finer recurrence history.
    if (!this.#counts.has(key) && this.#counts.size >= MAX_REJECTION_KEYS) {
      const oldestKey = this.#counts.keys().next().value;
      if (oldestKey !== undefined) {
        this.#counts.delete(oldestKey);
      }
    }

    this.#counts.set(key, count);
    return count;
  }
}

export class AutoModeGate {
  readonly #mode: GateMode;
  readonly #tracker: RejectionTracker;
  readonly #trustedExecutablePaths: ReadonlySet<string>;

  constructor(config: GateConfig = { mode: "enforce" }, tracker = new RejectionTracker()) {
    const resolvedConfig = readConfig(config);
    this.#mode = resolvedConfig.mode;
    this.#trustedExecutablePaths = new Set(resolvedConfig.trustedExecutablePaths);
    this.#tracker = tracker;
  }

  evaluate(input: unknown): GateDecision {
    try {
      const assessment = assess(input, this.#trustedExecutablePaths);
      return this.#finalize(assessment);
    } catch {
      return createInternalErrorDecision(this.#mode);
    }
  }

  async evaluateWithJudge(
    input: unknown,
    judge?: PermissionJudge,
    signal?: AbortSignal,
  ): Promise<GateDecision> {
    try {
      const assessment = assess(input, this.#trustedExecutablePaths);
      if (this.#mode !== "enforce" || assessment.state !== "unresolved-eligible") {
        return this.#finalize(assessment);
      }
      if (signal?.aborted) {
        return this.#finalize(assessment, { status: "cancelled" });
      }
      if (!judge) {
        return this.#finalize(assessment, { status: "unavailable" });
      }

      let outcome: PermissionJudgeOutcome;
      try {
        const fallbackSignal = signal ?? new AbortController().signal;
        const result = await evaluateJudgeWithCancellation(
          judge,
          assessment.eligibility.request,
          fallbackSignal,
        );
        if (result.cancelled || signal?.aborted) {
          outcome = { status: "cancelled" };
        } else {
          const normalized = normalizeJudgeOutcome(result.value);
          outcome = signal?.aborted ? { status: "cancelled" } : normalized;
        }
      } catch {
        outcome = { status: signal?.aborted ? "cancelled" : "error" };
      }
      return this.#finalize(assessment, outcome);
    } catch {
      return createInternalErrorDecision(this.#mode);
    }
  }

  #finalize(
    assessment: InternalAssessment,
    outcome?: PermissionJudgeOutcome,
  ): GateDecision {
    const resolution = resolveAssessment(assessment, outcome, this.#mode);
    const blocked = resolution.effect === "deny" && this.#mode === "enforce";
    const repeatedRejectionCount =
      resolution.effect === "deny"
        ? this.#tracker.record(assessment.equivalenceInput, resolution.code)
        : 0;
    const denial = isAllowCode(resolution.code) ? undefined : createDenial(resolution.code);
    const host = normalizeHost(assessment.action?.host);
    const shell = assessment.action?.shell ?? "unknown";
    const tool = assessment.action?.tool ?? "unknown";
    const log = Object.freeze({
      host,
      tool,
      shell,
      policyVerdict: assessment.policyVerdict,
      effect: resolution.effect,
      code: resolution.code,
      source: resolution.source,
      mode: this.#mode,
      blocked,
      repeatedRejectionCount,
    });

    return Object.freeze({
      policyVerdict: assessment.policyVerdict,
      effect: resolution.effect,
      code: resolution.code,
      source: resolution.source,
      mode: this.#mode,
      blocked,
      denial,
      repeatedRejectionCount,
      log,
    });
  }
}

export function mergeConfig(globalConfig: GateConfig, projectConfig?: Partial<GateConfig>): GateConfig {
  const global = readConfig(globalConfig);
  if (!projectConfig) {
    return global;
  }

  try {
    const rank: Record<GateMode, number> = { off: 0, shadow: 1, enforce: 2 };
    const projectMode =
      projectConfig.mode === undefined ? global.mode : normalizeMode(projectConfig.mode);
    const mode =
      global.mode === "off" || rank[global.mode] >= rank[projectMode] ? global.mode : projectMode;
    const trustedExecutablePaths =
      projectConfig.trustedExecutablePaths === undefined
        ? global.trustedExecutablePaths
        : intersectTrustedPaths(
            global.trustedExecutablePaths,
            normalizeTrustedPaths(projectConfig.trustedExecutablePaths),
          );
    return { mode, trustedExecutablePaths };
  } catch {
    return { mode: "enforce", trustedExecutablePaths: [] };
  }
}

function assess(input: unknown, trustedExecutablePaths: ReadonlySet<string>): InternalAssessment {
  if (!isRecord(input)) {
    return rejectUnknown(input);
  }

  const snapshot = readInputSnapshot(input);
  if (snapshot.kind !== "shell" || snapshot.tool !== "shell" || !isShell(snapshot.shell)) {
    return rejectUnknown(snapshot);
  }

  const executableIdentity = readExecutableIdentity(snapshot.executable);
  if (executableIdentity === null) {
    return {
      state: "deny-final",
      policyVerdict: "deny",
      code: "AMG_DENY_INVALID_INPUT",
      equivalenceInput: safeEquivalenceInput(snapshot),
    };
  }

  const action = Object.freeze({
    kind: "shell",
    tool: "shell",
    shell: snapshot.shell,
    command: snapshot.command,
    executable: executableIdentity,
    truncated: snapshot.truncated,
    host: normalizeHost(snapshot.host),
  }) as NormalizedShellAction;
  if (
    typeof action.command !== "string" ||
    action.command.trim() === "" ||
    action.command.length > MAX_SHELL_COMMAND_LENGTH ||
    (action.truncated !== undefined && typeof action.truncated !== "boolean") ||
    action.truncated === true
  ) {
    return {
      state: "deny-final",
      policyVerdict: "deny",
      code: "AMG_DENY_INVALID_INPUT",
      action,
      equivalenceInput: safeEquivalenceInput(action),
    };
  }

  const parsed = parseShellCommand(action.shell, action.command);
  if (parsed.status === "invalid") {
    return {
      state: "deny-final",
      policyVerdict: "deny",
      code: "AMG_DENY_INVALID_INPUT",
      action,
      equivalenceInput: safeEquivalenceInput(action),
    };
  }

  const executableToken = parsed.tokens[0];
  const executable = normalizeExecutableName(executableToken);
  if (!executable) {
    return ambiguous(action);
  }

  if (dangerousCommands[action.shell].has(executable)) {
    return dangerous(action);
  }

  if (executable === "git") {
    const subcommand = parsed.tokens[1]?.toLowerCase();
    if (
      (subcommand && dangerousGitCommands.has(subcommand)) ||
      parsed.tokens.some((token) => isDangerousGitOption(token))
    ) {
      return dangerous(action);
    }
    if (
      parsed.status === "parsed" &&
      subcommand &&
      safeGitCommands.has(subcommand) &&
      hasVerifiedExecutable(action, executableToken, executable, trustedExecutablePaths)
    ) {
      return allowed(action);
    }
    return unresolved(action, trustedExecutablePaths);
  }

  if (action.shell === "bash" && executable === "find") {
    if (parsed.tokens.some((token) => dangerousFindOptions.has(token.toLowerCase()))) {
      return dangerous(action);
    }
    return unresolved(action, trustedExecutablePaths);
  }

  if (
    parsed.status === "parsed" &&
    safeCommands[action.shell].has(executable) &&
    hasVerifiedExecutable(action, executableToken, executable, trustedExecutablePaths)
  ) {
    return allowed(action);
  }

  return unresolved(action, trustedExecutablePaths);
}

function allowed(action: NormalizedShellAction): InternalAssessment {
  return {
    state: "allow-final",
    policyVerdict: "allow",
    code: "AMG_ALLOW_SAFE_COMMAND",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function dangerous(action: NormalizedShellAction): InternalAssessment {
  return {
    state: "deny-final",
    policyVerdict: "deny",
    code: "AMG_DENY_DANGEROUS_COMMAND",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function unresolved(
  action: NormalizedShellAction,
  trustedExecutablePaths: ReadonlySet<string>,
): InternalAssessment {
  const request = buildPermissionJudgeRequest(action, [...trustedExecutablePaths]);
  if (!request) {
    return ambiguous(action);
  }
  return {
    state: "unresolved-eligible",
    policyVerdict: "ambiguous",
    eligibility: Object.freeze({ state: "eligible", request }),
    code: "AMG_DENY_AMBIGUOUS",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function ambiguous(action: NormalizedShellAction): InternalAssessment {
  return {
    state: "unresolved-ineligible",
    policyVerdict: "ambiguous",
    eligibility: Object.freeze({ state: "ineligible" }),
    code: "AMG_DENY_AMBIGUOUS",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function rejectUnknown(input: unknown): InternalAssessment {
  return {
    state: "deny-final",
    policyVerdict: "deny",
    code: "AMG_DENY_UNKNOWN_ACTION",
    equivalenceInput: safeEquivalenceInput(input),
  };
}

function resolveAssessment(
  assessment: InternalAssessment,
  outcome: PermissionJudgeOutcome | undefined,
  mode: GateMode,
): FinalResolution {
  if (assessment.state === "allow-final") {
    return { effect: "allow", code: "AMG_ALLOW_SAFE_COMMAND", source: "deterministic" };
  }
  if (assessment.state === "deny-final") {
    return { effect: "deny", code: assessment.code, source: "deterministic" };
  }
  if (assessment.state === "unresolved-ineligible" || mode !== "enforce") {
    return { effect: "deny", code: "AMG_DENY_AMBIGUOUS", source: "deterministic" };
  }

  if (outcome?.status === "response") {
    return outcome.response.verdict === "allow"
      ? { effect: "allow", code: "AMG_ALLOW_JUDGE", source: "judge" }
      : { effect: "deny", code: "AMG_DENY_JUDGE", source: "judge" };
  }

  switch (outcome?.status ?? "unavailable") {
    case "timeout":
      return { effect: "deny", code: "AMG_DENY_JUDGE_TIMEOUT", source: "judge" };
    case "cancelled":
      return { effect: "deny", code: "AMG_DENY_JUDGE_CANCELLED", source: "judge" };
    case "invalid-response":
      return { effect: "deny", code: "AMG_DENY_JUDGE_INVALID_RESPONSE", source: "judge" };
    case "error":
      return { effect: "deny", code: "AMG_DENY_JUDGE_ERROR", source: "judge" };
    case "unavailable":
      return { effect: "deny", code: "AMG_DENY_JUDGE_UNAVAILABLE", source: "judge" };
  }
}

function evaluateJudgeWithCancellation(
  judge: PermissionJudge,
  request: PermissionJudgeRequest,
  signal: AbortSignal,
): Promise<{ readonly cancelled: true } | { readonly cancelled: false; readonly value: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: { readonly cancelled: true } | { readonly cancelled: false; readonly value: unknown },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        signal.removeEventListener("abort", cancel);
      } catch {
        // Cleanup failure must not keep the permission decision pending.
      }
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        signal.removeEventListener("abort", cancel);
      } catch {
        // Cleanup failure must not keep the permission decision pending.
      }
      reject(error);
    };
    const cancel = () => finish({ cancelled: true });

    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });

    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(judge.evaluate(request, signal));
    } catch (error) {
      fail(error);
      return;
    }
    pending.then(
      (value) => finish({ cancelled: false, value }),
      fail,
    );
  });
}

function normalizeJudgeOutcome(value: unknown): PermissionJudgeOutcome {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(
        value,
        value.status === "response" ? ["status", "response"] : ["status"],
      )
    ) {
      return invalidJudgeOutcome();
    }

    if (value.status === "response") {
      const response = value.response;
      if (
        !isRecord(response) ||
        !hasExactKeys(response, ["protocol", "verdict"]) ||
        response.protocol !== "amg-permission-judge/v1" ||
        (response.verdict !== "allow" && response.verdict !== "deny")
      ) {
        return invalidJudgeOutcome();
      }
      return Object.freeze({
        status: "response",
        response: Object.freeze({ protocol: response.protocol, verdict: response.verdict }),
      });
    }

    if (
      value.status === "unavailable" ||
      value.status === "timeout" ||
      value.status === "cancelled" ||
      value.status === "invalid-response" ||
      value.status === "error"
    ) {
      return Object.freeze({ status: value.status });
    }
    return invalidJudgeOutcome();
  } catch {
    return invalidJudgeOutcome();
  }
}

function invalidJudgeOutcome(): PermissionJudgeOutcome {
  return Object.freeze({ status: "invalid-response" });
}

function isAllowCode(
  code: DecisionCode,
): code is Extract<DecisionCode, "AMG_ALLOW_SAFE_COMMAND" | "AMG_ALLOW_JUDGE"> {
  return code === "AMG_ALLOW_SAFE_COMMAND" || code === "AMG_ALLOW_JUDGE";
}

function createDenial(
  code: Exclude<DecisionCode, "AMG_ALLOW_SAFE_COMMAND" | "AMG_ALLOW_JUDGE">,
): StructuredDenial {
  return Object.freeze({ code, message: messages[code] });
}

function createInternalErrorDecision(mode: GateMode): GateDecision {
  const code = "AMG_DENY_INTERNAL_ERROR";
  const blocked = mode === "enforce";
  const denial = createDenial(code);
  const log = {
    host: "unknown",
    tool: "unknown",
    shell: "unknown",
    policyVerdict: "deny",
    effect: "deny",
    code,
    source: "deterministic",
    mode,
    blocked,
    repeatedRejectionCount: 0,
  } as const;

  return Object.freeze({
    policyVerdict: "deny",
    effect: "deny",
    code,
    source: "deterministic",
    mode,
    blocked,
    denial,
    repeatedRejectionCount: 0,
    log: Object.freeze(log),
  });
}

function hasVerifiedExecutable(
  action: NormalizedShellAction,
  executableToken: string,
  executable: string,
  trustedExecutablePaths: ReadonlySet<string>,
): boolean {
  const identity = action.executable;
  return (
    identity?.source === "trusted-path" &&
    identity.path === executableToken &&
    trustedExecutablePaths.has(identity.path) &&
    isAbsolutePath(identity.path) &&
    normalizeExecutableName(identity.name) === executable
  );
}

function isDangerousGitOption(token: string): boolean {
  const option = token.toLowerCase();
  return (
    dangerousGitOptions.has(option) ||
    option === "--output" ||
    option.startsWith("--output=")
  );
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\");
}

function normalizeHost(host: unknown): KnownHost {
  return host === "opencode" || host === "pi" ? host : "unknown";
}

function readConfig(config: GateConfig): GateConfig & { trustedExecutablePaths: readonly string[] } {
  try {
    return {
      mode: normalizeMode(config.mode),
      trustedExecutablePaths: normalizeTrustedPaths(config.trustedExecutablePaths),
    };
  } catch {
    return { mode: "enforce", trustedExecutablePaths: [] };
  }
}

function normalizeTrustedPaths(paths: unknown): readonly string[] {
  if (paths === undefined) {
    return [];
  }
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !isAbsolutePath(path))) {
    return [];
  }
  return [...new Set(paths)];
}

function intersectTrustedPaths(
  globalPaths: readonly string[],
  projectPaths: readonly string[],
): readonly string[] {
  const projectSet = new Set(projectPaths);
  return globalPaths.filter((path) => projectSet.has(path));
}

function normalizeMode(mode: unknown): GateMode {
  return mode === "off" || mode === "shadow" || mode === "enforce" ? mode : "enforce";
}

function isShell(value: unknown): value is Shell {
  return value === "bash" || value === "powershell" || value === "cmd";
}

function readInputSnapshot(input: Record<string, unknown>): InputSnapshot {
  return {
    kind: input.kind,
    tool: input.tool,
    shell: input.shell,
    command: input.command,
    executable: input.executable,
    truncated: input.truncated,
    host: input.host,
  };
}

function readExecutableIdentity(input: unknown): VerifiedExecutable | undefined | null {
  if (input === undefined) {
    return undefined;
  }
  if (!isRecord(input)) {
    return null;
  }

  const name = input.name;
  const path = input.path;
  const source = input.source;
  if (
    typeof name !== "string" ||
    name === "" ||
    typeof path !== "string" ||
    path === "" ||
    source !== "trusted-path"
  ) {
    return null;
  }

  return Object.freeze({ name, path, source });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function safeEquivalenceInput(input: unknown): string {
  if (!isRecord(input)) {
    return typeof input;
  }

  const command = input.command;
  return JSON.stringify({
    kind: typeof input.kind === "string" ? input.kind : typeof input.kind,
    tool: typeof input.tool === "string" ? input.tool : typeof input.tool,
    shell: typeof input.shell === "string" ? input.shell : typeof input.shell,
    command: typeof command === "string" ? command.slice(0, MAX_SHELL_COMMAND_LENGTH) : typeof command,
    commandLength: typeof command === "string" ? command.length : undefined,
    truncated: input.truncated === true,
  });
}

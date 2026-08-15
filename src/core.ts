import { createHash } from "node:crypto";

import { parseShellCommand } from "./shell.ts";
import type {
  DecisionCode,
  GateConfig,
  GateDecision,
  GateMode,
  KnownHost,
  NormalizedShellAction,
  PolicyVerdict,
  Shell,
  StructuredDenial,
  VerifiedExecutable,
} from "./types.ts";

const MAX_COMMAND_LENGTH = 4_096;
const MAX_REJECTION_KEYS = 1_024;

const messages: Record<Exclude<DecisionCode, "AMG_ALLOW_SAFE_COMMAND">, string> = {
  AMG_DENY_DANGEROUS_COMMAND: "The command matches a deterministic deny rule.",
  AMG_DENY_AMBIGUOUS: "The command could not be classified as safe.",
  AMG_DENY_UNKNOWN_ACTION: "The action type or shell is not supported.",
  AMG_DENY_INVALID_INPUT: "The action input is missing, truncated, or invalid.",
  AMG_DENY_INTERNAL_ERROR: "The action could not be evaluated safely.",
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

interface Classification {
  readonly verdict: PolicyVerdict;
  readonly code: DecisionCode;
  readonly action?: NormalizedShellAction;
  readonly equivalenceInput: string;
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

    // ponytail: cap session memory; use an LRU only if long sessions need finer recurrence history.
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
      return this.#createDecision(classify(input, this.#trustedExecutablePaths));
    } catch {
      return createInternalErrorDecision(this.#mode);
    }
  }

  #createDecision(classification: Classification): GateDecision {
    const effect = classification.verdict === "allow" ? "allow" : "deny";
    const blocked = effect === "deny" && this.#mode === "enforce";
    const repeatedRejectionCount =
      effect === "deny"
        ? this.#tracker.record(classification.equivalenceInput, classification.code)
        : 0;
    const denial = effect === "deny" ? createDenial(classification.code) : undefined;
    const host = normalizeHost(classification.action?.host);
    const shell = classification.action?.shell ?? "unknown";
    const tool = classification.action?.tool ?? "unknown";
    const log = Object.freeze({
      host,
      tool,
      shell,
      policyVerdict: classification.verdict,
      effect,
      code: classification.code,
      source: "deterministic",
      mode: this.#mode,
      blocked,
      repeatedRejectionCount,
    });

    return Object.freeze({
      policyVerdict: classification.verdict,
      effect,
      code: classification.code,
      source: "deterministic",
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

function classify(input: unknown, trustedExecutablePaths: ReadonlySet<string>): Classification {
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
      verdict: "deny",
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
    action.command.length > MAX_COMMAND_LENGTH ||
    (action.truncated !== undefined && typeof action.truncated !== "boolean") ||
    action.truncated === true
  ) {
    return {
      verdict: "deny",
      code: "AMG_DENY_INVALID_INPUT",
      action,
      equivalenceInput: safeEquivalenceInput(action),
    };
  }

  const parsed = parseShellCommand(action.shell, action.command);
  if (parsed.status === "invalid") {
    return {
      verdict: "deny",
      code: "AMG_DENY_INVALID_INPUT",
      action,
      equivalenceInput: safeEquivalenceInput(action),
    };
  }

  const executableToken = parsed.tokens[0];
  const executable = normalizeExecutable(executableToken);
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
    return ambiguous(action);
  }

  if (action.shell === "bash" && executable === "find") {
    if (parsed.tokens.some((token) => dangerousFindOptions.has(token.toLowerCase()))) {
      return dangerous(action);
    }
    return ambiguous(action);
  }

  if (
    parsed.status === "parsed" &&
    safeCommands[action.shell].has(executable) &&
    hasVerifiedExecutable(action, executableToken, executable, trustedExecutablePaths)
  ) {
    return allowed(action);
  }

  return ambiguous(action);
}

function allowed(action: NormalizedShellAction): Classification {
  return {
    verdict: "allow",
    code: "AMG_ALLOW_SAFE_COMMAND",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function dangerous(action: NormalizedShellAction): Classification {
  return {
    verdict: "deny",
    code: "AMG_DENY_DANGEROUS_COMMAND",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function ambiguous(action: NormalizedShellAction): Classification {
  return {
    verdict: "ambiguous",
    code: "AMG_DENY_AMBIGUOUS",
    action,
    equivalenceInput: safeEquivalenceInput(action),
  };
}

function rejectUnknown(input: unknown): Classification {
  return {
    verdict: "deny",
    code: "AMG_DENY_UNKNOWN_ACTION",
    equivalenceInput: safeEquivalenceInput(input),
  };
}

function createDenial(code: DecisionCode): StructuredDenial {
  if (code === "AMG_ALLOW_SAFE_COMMAND") {
    throw new Error("An allow decision cannot create a denial.");
  }
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
    normalizeExecutable(identity.name) === executable
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

function normalizeExecutable(executable: string): string {
  const name = executable.split(/[\\/]/u).at(-1) ?? "";
  return name.toLowerCase().replace(/\.(?:bat|cmd|com|exe)$/u, "");
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

function safeEquivalenceInput(input: unknown): string {
  if (!isRecord(input)) {
    return typeof input;
  }

  const command = input.command;
  return JSON.stringify({
    kind: typeof input.kind === "string" ? input.kind : typeof input.kind,
    tool: typeof input.tool === "string" ? input.tool : typeof input.tool,
    shell: typeof input.shell === "string" ? input.shell : typeof input.shell,
    command: typeof command === "string" ? command.slice(0, MAX_COMMAND_LENGTH) : typeof command,
    commandLength: typeof command === "string" ? command.length : undefined,
    truncated: input.truncated === true,
  });
}

import { AutoModeGate, mergeConfig } from "./core.ts";
import { normalizeExecutableName } from "./shell.ts";
import type {
  DecisionLogRecord,
  GateConfig,
  GateDecision,
  KnownHost,
  PermissionJudge,
  PermissionJudgeAuthorization,
  Shell,
  VerifiedExecutable,
} from "./types.ts";

export interface AdapterOptions {
  readonly shell?: Shell;
  readonly globalConfig?: GateConfig;
  readonly projectConfig?: Partial<GateConfig>;
  readonly permissionJudge?: PermissionJudgeAuthorization;
  readonly onDecision?: (log: DecisionLogRecord) => void;
}

export interface AdapterShellCall {
  readonly command: unknown;
  readonly shell?: unknown;
  readonly truncated?: unknown;
}

export interface AdapterEvaluation {
  readonly decision: GateDecision;
  readonly command: unknown;
}

export interface ShellAdapter {
  evaluate(call: AdapterShellCall): AdapterEvaluation;
  evaluateWithJudge?(
    call: AdapterShellCall,
    judge?: PermissionJudge,
    signal?: AbortSignal,
  ): Promise<AdapterEvaluation>;
}

export function createShellAdapter(host: KnownHost, options: AdapterOptions = {}): ShellAdapter {
  try {
    const config = mergeConfig(options.globalConfig ?? { mode: "enforce" }, options.projectConfig);
    const gate = new AutoModeGate(config);
    const configuredShell = options.shell;
    const trustedPaths = config.trustedExecutablePaths ?? [];

    return Object.freeze({
      evaluate(call: AdapterShellCall): AdapterEvaluation {
        try {
          const input = normalizeCall(call, configuredShell, trustedPaths, host);
          const decision = gate.evaluate(input.action);
          notifyDecision(options.onDecision, decision.log);
          return Object.freeze({ decision, command: input.command });
        } catch {
          return internalError(gate);
        }
      },
      async evaluateWithJudge(
        call: AdapterShellCall,
        judge?: PermissionJudge,
        signal?: AbortSignal,
      ) {
        try {
          const input = normalizeCall(call, configuredShell, trustedPaths, host);
          const authorizedJudge = options.permissionJudge?.authorized === false ? undefined : judge;
          const decision = await gate.evaluateWithJudge(input.action, authorizedJudge, signal);
          notifyDecision(options.onDecision, decision.log);
          return Object.freeze({ decision, command: input.command });
        } catch {
          return internalError(gate);
        }
      },
    });
  } catch {
    const gate = new AutoModeGate({ mode: "enforce" });
    return Object.freeze({
      evaluate: () => internalError(gate),
      evaluateWithJudge: async () => internalError(gate),
    });
  }
}

function normalizeCall(
  call: AdapterShellCall,
  configuredShell: Shell | undefined,
  trustedPaths: readonly string[],
  host: KnownHost,
) {
  const shell = call.shell ?? configuredShell;
  const binding = bindExecutable(call.command, shell, trustedPaths);
  const command = binding?.command ?? call.command;
  return {
    command,
    action: {
      kind: "shell",
      tool: "shell",
      shell,
      command,
      executable: binding?.executable,
      truncated: call.truncated,
      host,
    },
  };
}

export function denialReason(decision: GateDecision): string {
  return `${decision.code}: ${decision.denial?.message ?? "The action could not be evaluated safely."}`;
}

export interface HostInputSnapshot {
  readonly input: Record<string, unknown>;
  readonly command: string;
}

export function snapshotHostInput(input: unknown): HostInputSnapshot | undefined | null {
  try {
    if (!isRecord(input)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, "command");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    return Object.freeze({ input, command: descriptor.value });
  } catch {
    return null;
  }
}

export function protectApprovedInput(
  snapshot: HostInputSnapshot | undefined | null,
  decision: GateDecision,
): boolean {
  if (decision.mode !== "enforce" || decision.effect !== "allow") {
    return true;
  }
  if (!snapshot) {
    return false;
  }
  try {
    const current = Object.getOwnPropertyDescriptor(snapshot.input, "command");
    if (!current || !("value" in current) || current.value !== snapshot.command) {
      return false;
    }
    Object.defineProperty(snapshot.input, "command", {
      value: snapshot.command,
      enumerable: current.enumerable,
      writable: false,
      configurable: false,
    });
    Object.freeze(snapshot.input);
    const protectedCommand = Object.getOwnPropertyDescriptor(snapshot.input, "command");
    return Boolean(
      protectedCommand &&
      "value" in protectedCommand &&
      protectedCommand.value === snapshot.command &&
      protectedCommand.writable === false &&
      protectedCommand.configurable === false &&
      Object.isFrozen(snapshot.input) &&
      snapshot.input.command === snapshot.command
    );
  } catch {
    return false;
  }
}

function bindExecutable(
  command: unknown,
  shell: unknown,
  trustedPaths: readonly string[],
): { readonly command: string; readonly executable: VerifiedExecutable } | undefined {
  if (typeof command !== "string" || !isShell(shell)) {
    return undefined;
  }

  const head = readCommandHead(command, shell);
  if (!head) {
    return undefined;
  }

  if (!isAbsolutePath(head.token) || !trustedPaths.includes(head.token)) {
    return undefined;
  }

  return {
    command,
    executable: Object.freeze({
      name: normalizeExecutableName(head.token),
      path: head.token,
      source: "trusted-path",
    }),
  };
}

function readCommandHead(command: string, shell: Shell): { readonly token: string } | undefined {
  const start = command.search(/\S/u);
  if (start < 0) {
    return undefined;
  }

  const quote = command[start];
  const quotes = shell === "cmd" ? ['"'] : ["'", '"'];
  if (quotes.includes(quote)) {
    const endQuote = command.indexOf(quote, start + 1);
    if (endQuote < 0 || (command[endQuote + 1] !== undefined && !/\s/u.test(command[endQuote + 1]))) {
      return undefined;
    }
    return { token: command.slice(start + 1, endQuote) };
  }

  const relativeEnd = command.slice(start).search(/\s/u);
  const end = relativeEnd < 0 ? command.length : start + relativeEnd;
  return { token: command.slice(start, end) };
}

function notifyDecision(
  callback: AdapterOptions["onDecision"],
  log: DecisionLogRecord,
): void {
  const result = (callback as ((record: DecisionLogRecord) => unknown) | undefined)?.(log);
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Decision callbacks must complete synchronously.");
  }
}

function internalError(gate: AutoModeGate): AdapterEvaluation {
  const unreadable = new Proxy({}, { get: () => { throw new Error("unreadable adapter input"); } });
  return Object.freeze({ decision: gate.evaluate(unreadable), command: undefined });
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\");
}

function isShell(value: unknown): value is Shell {
  return value === "bash" || value === "powershell" || value === "cmd";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  try {
    return (
      (typeof value === "object" && value !== null) || typeof value === "function"
    ) && typeof (value as { readonly then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

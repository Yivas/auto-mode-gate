import {
  createShellAdapter,
  denialReason,
  type AdapterOptions,
  type ShellAdapter,
} from "./adapter.ts";

export interface PiToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
}

export interface PiToolCallBlock {
  readonly block: true;
  readonly reason: string;
}

export interface PiExtensionContext {
  readonly cwd?: string;
  readonly [key: string]: unknown;
}

export interface PiExtensionAPI {
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEvent,
      context: PiExtensionContext,
    ) => PiToolCallBlock | undefined,
  ): void;
}

export type PiExtension = (pi: PiExtensionAPI) => void;
export type PiAdapterOptionsResolver = (context: PiExtensionContext) => AdapterOptions;

export function createPiExtension(
  options: AdapterOptions | PiAdapterOptionsResolver = {},
): PiExtension {
  const resolveAdapter = createAdapterResolver(options);
  return (pi) => registerToolCall(pi, resolveAdapter);
}

export default createPiExtension();

function registerToolCall(
  pi: PiExtensionAPI,
  resolveAdapter: (context: PiExtensionContext) => ShellAdapter,
): void {
  pi.on("tool_call", (event, context) => {
    try {
      if (event.toolName !== "bash") {
        return undefined;
      }

      const input = isRecord(event.input) ? event.input : undefined;
      const evaluation = resolveAdapter(context).evaluate({ command: input?.command });
      if (evaluation.decision.blocked) {
        return { block: true, reason: denialReason(evaluation.decision) };
      }
      return undefined;
    } catch {
      return {
        block: true,
        reason: "AMG_DENY_INTERNAL_ERROR: The action could not be evaluated safely.",
      };
    }
  });
}

function createAdapterResolver(
  options: AdapterOptions | PiAdapterOptionsResolver,
): (context: PiExtensionContext) => ShellAdapter {
  if (typeof options !== "function") {
    const adapter = createShellAdapter("pi", options);
    return () => adapter;
  }

  const adapters = new Map<string, ShellAdapter>();
  return (context) => {
    const key = context.cwd ?? "";
    const existing = adapters.get(key);
    if (existing) {
      return existing;
    }

    let adapter: ShellAdapter;
    try {
      adapter = createShellAdapter("pi", options(context));
    } catch {
      adapter = createShellAdapter("pi", {
        onDecision() {
          throw new Error("Auto Mode Gate configuration could not be loaded safely.");
        },
      });
    }
    adapters.set(key, adapter);
    return adapter;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

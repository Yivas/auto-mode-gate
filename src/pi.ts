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

export interface PiExtensionAPI {
  on(
    event: "tool_call",
    handler: (event: PiToolCallEvent, context: unknown) => PiToolCallBlock | undefined,
  ): void;
}

export type PiExtension = (pi: PiExtensionAPI) => void;

export function createPiExtension(options: AdapterOptions = {}): PiExtension {
  const adapter = createShellAdapter("pi", options);
  return (pi) => registerToolCall(pi, adapter);
}

export default createPiExtension();

function registerToolCall(pi: PiExtensionAPI, adapter: ShellAdapter): void {
  pi.on("tool_call", (event) => {
    try {
      if (event.toolName !== "bash") {
        return undefined;
      }

      const input = isRecord(event.input) ? event.input : undefined;
      const evaluation = adapter.evaluate({ command: input?.command });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

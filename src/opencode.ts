import {
  createShellAdapter,
  denialReason,
  type AdapterOptions,
  type ShellAdapter,
} from "./adapter.ts";

export interface OpenCodeToolBeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

export interface OpenCodeToolBeforeOutput {
  readonly args: unknown;
}

export interface OpenCodeHooks {
  readonly "tool.execute.before": (
    input: OpenCodeToolBeforeInput,
    output: OpenCodeToolBeforeOutput,
  ) => Promise<void>;
}

export type OpenCodePlugin = (
  input: unknown,
  options?: Record<string, unknown>,
) => Promise<OpenCodeHooks>;

export function createOpenCodeHooks(options: AdapterOptions = {}): OpenCodeHooks {
  return createHooks(createShellAdapter("opencode", options));
}

export function createOpenCodePlugin(options: AdapterOptions = {}): OpenCodePlugin {
  return async () => createOpenCodeHooks(options);
}

export const AutoModeGateOpenCodePlugin: OpenCodePlugin = async (_input, options) =>
  createOpenCodeHooks(options as AdapterOptions | undefined);

function createHooks(adapter: ShellAdapter): OpenCodeHooks {
  return Object.freeze({
    async "tool.execute.before"(
      input: OpenCodeToolBeforeInput,
      output: OpenCodeToolBeforeOutput,
    ): Promise<void> {
      let reason: string | undefined;
      try {
        if (input.tool !== "bash") {
          return;
        }

        const args = isRecord(output.args) ? output.args : undefined;
        const evaluation = adapter.evaluate({ command: args?.command });
        if (evaluation.decision.blocked) {
          reason = denialReason(evaluation.decision);
        }
      } catch {
        throw new Error("AMG_DENY_INTERNAL_ERROR: The action could not be evaluated safely.");
      }

      if (reason) {
        throw new Error(reason);
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

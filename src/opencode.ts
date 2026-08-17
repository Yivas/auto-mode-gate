import {
  createShellAdapter,
  denialReason,
  protectApprovedInput,
  snapshotHostInput,
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

        const snapshot = snapshotHostInput(output.args);
        if (snapshot === null) {
          throw new Error("AMG_DENY_INTERNAL_ERROR: The action input could not be read safely.");
        }
        const evaluation = adapter.evaluate({ command: snapshot?.command });
        if (evaluation.decision.blocked) {
          reason = denialReason(evaluation.decision);
        } else if (!protectApprovedInput(snapshot, evaluation.decision)) {
          reason = "AMG_DENY_INTERNAL_ERROR: The approved action could not be protected from later mutation.";
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

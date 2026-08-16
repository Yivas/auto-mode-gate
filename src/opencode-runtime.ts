import { loadAdapterOptions } from "./config.ts";
import { createOpenCodeHooks, type OpenCodePlugin } from "./opencode.ts";

export const AutoModeGatePlugin: OpenCodePlugin = async (input) => {
  try {
    return createOpenCodeHooks(loadAdapterOptions(readDirectory(input)));
  } catch {
    return createOpenCodeHooks({
      onDecision() {
        throw new Error("Auto Mode Gate configuration could not be loaded safely.");
      },
    });
  }
};

function readDirectory(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const directory = (input as Record<string, unknown>).directory;
  return typeof directory === "string" ? directory : undefined;
}

import { loadAdapterOptions } from "./config.ts";
import { createOpenCodeHooks, type OpenCodePlugin } from "./opencode.ts";

export const AutoModeGatePlugin: OpenCodePlugin = async (input) => {
  try {
    return createOpenCodeHooks(loadAdapterOptions("opencode", readDirectory(input)));
  } catch {
    return createOpenCodeHooks({
      onDecision() {
        throw new Error("Auto Mode Gate configuration could not be loaded safely.");
      },
    });
  }
};

function readDirectory(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("OpenCode did not provide a project directory.");
  }
  const directory = (input as Record<string, unknown>).directory;
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new Error("OpenCode did not provide a project directory.");
  }
  return directory;
}

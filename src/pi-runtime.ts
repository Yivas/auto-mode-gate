import { loadAdapterOptions } from "./config.ts";
import { createPiExtension, type PiExtension, type PiExtensionContext } from "./pi.ts";

export function createConfiguredPiExtension(): PiExtension {
  return createPiExtension((context) => loadAdapterOptions(readDirectory(context)));
}

export default createConfiguredPiExtension();

function readDirectory(context: PiExtensionContext): string {
  if (typeof context.cwd !== "string" || context.cwd.trim() === "") {
    throw new Error("Pi did not provide a project directory.");
  }
  return context.cwd;
}

import { loadAdapterOptions } from "./config.ts";
import { createPiExtension, type PiExtension } from "./pi.ts";

export function createConfiguredPiExtension(): PiExtension {
  return createPiExtension((context) => loadAdapterOptions(context.cwd));
}

export default createConfiguredPiExtension();

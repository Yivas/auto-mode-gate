import { getDefaultPiPreferencesPath, loadAdapterOptions } from "./config.ts";
import { createPiExtension, type PiExtension, type PiExtensionContext } from "./pi.ts";
import {
  createFilePiPreferenceRepository,
  createUnavailablePiPreferenceRepository,
} from "./pi-preferences.ts";

export function createConfiguredPiExtension(): PiExtension {
  const preferences = createPreferencesRepository();
  return createPiExtension(
    (context) => loadAdapterOptions("pi", readDirectory(context)),
    preferences,
  );
}

export default createConfiguredPiExtension();

function createPreferencesRepository() {
  try {
    return createFilePiPreferenceRepository(getDefaultPiPreferencesPath());
  } catch {
    return createUnavailablePiPreferenceRepository();
  }
}

function readDirectory(context: PiExtensionContext): string {
  if (typeof context.cwd !== "string" || context.cwd.trim() === "") {
    throw new Error("Pi did not provide a project directory.");
  }
  return context.cwd;
}

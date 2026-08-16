import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import type { AdapterOptions } from "./adapter.ts";
import type { DecisionLogRecord, GateConfig, GateMode, Shell } from "./types.ts";

export const PROJECT_CONFIG_NAME = ".auto-mode-gate.json";

export interface ConfigDiscoveryOptions {
  readonly globalConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

interface GlobalFileConfig extends GateConfig {
  readonly shell?: Shell;
  readonly logPath?: string;
}

export function loadAdapterOptions(
  projectDirectory?: string,
  discovery: ConfigDiscoveryOptions = {},
): AdapterOptions {
  try {
    const platform = discovery.platform ?? process.platform;
    const path = pathForPlatform(platform);
    const globalPath = discovery.globalConfigPath
      ? readAbsolutePath(discovery.globalConfigPath, platform)
      : getDefaultGlobalConfigPath(discovery.env, platform, discovery.homeDirectory);
    const global = parseGlobalConfig(readOptionalJson(globalPath), platform);
    const projectPath = discovery.projectConfigPath
      ? readAbsolutePath(discovery.projectConfigPath, platform)
      : projectDirectory
        ? path.join(readAbsolutePath(projectDirectory, platform), PROJECT_CONFIG_NAME)
        : undefined;
    const project = parseProjectConfig(
      projectPath ? readOptionalJson(projectPath) : undefined,
      platform,
    );

    return {
      shell: global.shell,
      globalConfig: {
        mode: global.mode,
        trustedExecutablePaths: global.trustedExecutablePaths,
      },
      projectConfig: project,
      onDecision: global.logPath ? createDecisionLogger(global.logPath) : undefined,
    };
  } catch {
    return {
      globalConfig: { mode: "enforce", trustedExecutablePaths: [] },
      onDecision() {
        throw new Error("Auto Mode Gate configuration could not be loaded safely.");
      },
    };
  }
}

export function getDefaultGlobalConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const path = pathForPlatform(platform);
  const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(
      readAbsolutePath(xdgConfigHome, platform),
      "auto-mode-gate",
      "config.json",
    );
  }

  const home = readAbsolutePath(homeDirectory, platform);
  const applicationData = nonEmpty(env.APPDATA);
  const base =
    platform === "win32" && applicationData
      ? readAbsolutePath(applicationData, platform)
      : path.join(home, ".config");
  return path.join(base, "auto-mode-gate", "config.json");
}

function parseGlobalConfig(value: unknown, platform: NodeJS.Platform): GlobalFileConfig {
  if (value === undefined) {
    return { mode: "enforce", trustedExecutablePaths: [] };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "shell", "trustedExecutablePaths", "logPath"])
  ) {
    throw new Error("Invalid global configuration.");
  }

  const mode = readMode(value.mode);
  const shell = value.shell === undefined ? undefined : readShell(value.shell);
  const trustedExecutablePaths = readPaths(value.trustedExecutablePaths, platform);
  const logPath =
    value.logPath === undefined ? undefined : readAbsolutePath(value.logPath, platform);
  return { mode, shell, trustedExecutablePaths, logPath };
}

function parseProjectConfig(
  value: unknown,
  platform: NodeJS.Platform,
): Partial<GateConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["mode", "trustedExecutablePaths"])) {
    throw new Error("Invalid project configuration.");
  }

  return {
    mode: value.mode === undefined ? undefined : readMode(value.mode),
    trustedExecutablePaths:
      value.trustedExecutablePaths === undefined
        ? undefined
        : readPaths(value.trustedExecutablePaths, platform),
  };
}

function readOptionalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function createDecisionLogger(path: string): (log: DecisionLogRecord) => void {
  return (log) => appendFileSync(path, `${JSON.stringify(log)}\n`, "utf8");
}

function readMode(value: unknown): GateMode {
  if (value === undefined) {
    return "enforce";
  }
  if (value === "off" || value === "shadow" || value === "enforce") {
    return value;
  }
  throw new Error("Invalid gate mode.");
}

function readShell(value: unknown): Shell {
  if (value === "bash" || value === "powershell" || value === "cmd") {
    return value;
  }
  throw new Error("Invalid shell.");
}

function readPaths(value: unknown, platform: NodeJS.Platform): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((path) => typeof path !== "string" || !pathForPlatform(platform).isAbsolute(path))
  ) {
    throw new Error("Invalid path list.");
  }
  return [...new Set(value)];
}

function readAbsolutePath(value: unknown, platform: NodeJS.Platform): string {
  if (typeof value !== "string" || !pathForPlatform(platform).isAbsolute(value)) {
    throw new Error("Invalid absolute path.");
  }
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

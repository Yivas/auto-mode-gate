import { appendFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import type { AdapterOptions } from "./adapter.ts";
import { readOrMigrateConfig } from "./config-migration.ts";
import {
  MAX_PERMISSION_JUDGE_TIMEOUT_MS,
  MIN_PERMISSION_JUDGE_TIMEOUT_MS,
} from "./limits.ts";
import type {
  DecisionLogRecord,
  GateConfig,
  GateMode,
  PermissionJudgeAuthorization,
  Shell,
} from "./types.ts";
import { createPermissionJudgeModelReference } from "./session.ts";

export const PROJECT_CONFIG_NAME = "auto-mode-gate.json";
export const LEGACY_PROJECT_CONFIG_NAME = ".auto-mode-gate.json";

const MAX_TRUSTED_EXECUTABLE_PATHS = 256;

export type ConfigHost = "opencode" | "pi";

export interface ConfigDiscoveryOptions {
  readonly globalConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly legacyGlobalConfigPath?: string;
  readonly legacyProjectConfigPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

interface GlobalFileConfig extends GateConfig {
  readonly shell?: Shell;
  readonly logPath?: string;
  readonly permissionJudge: PermissionJudgeAuthorization;
}

interface ProjectFileConfig {
  readonly gateConfig: Partial<GateConfig>;
  readonly judgeDisabled: boolean;
  readonly judgeTimeoutMs?: number;
}

export function loadAdapterOptions(
  host: ConfigHost,
  projectDirectory?: string,
  discovery: ConfigDiscoveryOptions = {},
): AdapterOptions {
  try {
    const platform = discovery.platform ?? process.platform;
    const path = pathForPlatform(platform);
    const environment = discovery.env ?? process.env;
    const homeDirectory = discovery.homeDirectory ?? homedir();
    const globalPath = discovery.globalConfigPath
      ? readAbsolutePath(discovery.globalConfigPath, platform)
      : getDefaultGlobalConfigPath(host, environment, platform, homeDirectory);
    const globalValue = readOrMigrateConfig(
      globalPath,
      () => discovery.legacyGlobalConfigPath
        ? readAbsolutePath(discovery.legacyGlobalConfigPath, platform)
        : getLegacyGlobalConfigPath(environment, platform, homeDirectory),
      (value) => { parseGlobalConfig(value, platform); },
    );
    const global = parseGlobalConfig(globalValue, platform);
    const projectRoot = projectDirectory
      ? readAbsolutePath(projectDirectory, platform)
      : undefined;
    const projectPath = discovery.projectConfigPath
      ? readAbsolutePath(discovery.projectConfigPath, platform)
      : projectRoot
        ? path.join(projectRoot, host === "opencode" ? ".opencode" : ".pi", PROJECT_CONFIG_NAME)
        : undefined;
    const projectValue = projectPath
      ? readOrMigrateConfig(
          projectPath,
          () => discovery.legacyProjectConfigPath
            ? readAbsolutePath(discovery.legacyProjectConfigPath, platform)
            : projectRoot
              ? path.join(projectRoot, LEGACY_PROJECT_CONFIG_NAME)
              : undefined,
          (value) => { parseProjectConfig(value, platform); },
        )
      : undefined;
    const project = parseProjectConfig(projectValue, platform);

    return {
      shell: global.shell,
      globalConfig: {
        mode: global.mode,
        trustedExecutablePaths: global.trustedExecutablePaths,
      },
      projectConfig: project?.gateConfig,
      permissionJudge: resolvePermissionJudge(global.permissionJudge, project),
      onDecision: global.logPath ? createDecisionLogger(global.logPath) : undefined,
    };
  } catch {
    return {
      globalConfig: { mode: "enforce", trustedExecutablePaths: [] },
      permissionJudge: disabledPermissionJudge(),
      onDecision() {
        throw new Error("Auto Mode Gate configuration could not be loaded safely.");
      },
    };
  }
}

export function getDefaultGlobalConfigPath(
  host: ConfigHost,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const path = pathForPlatform(platform);
  const configuredRoot = nonEmpty(
    host === "opencode" ? env.OPENCODE_CONFIG_DIR : env.PI_CODING_AGENT_DIR,
  );
  if (configuredRoot) {
    const root = readAbsolutePath(configuredRoot, platform);
    assertExistingDirectory(root);
    return path.join(root, PROJECT_CONFIG_NAME);
  }

  const home = readAbsolutePath(homeDirectory, platform);
  const root = host === "opencode"
    ? path.join(home, ".config", "opencode")
    : path.join(home, ".pi", "agent");
  return path.join(root, PROJECT_CONFIG_NAME);
}

export function getLegacyGlobalConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const path = pathForPlatform(platform);
  const xdgConfigHome = platform === "win32" ? undefined : nonEmpty(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(readAbsolutePath(xdgConfigHome, platform), "auto-mode-gate", "config.json");
  }

  const home = readAbsolutePath(homeDirectory, platform);
  const applicationData = nonEmpty(env.APPDATA);
  const base = platform === "win32" && applicationData
    ? readAbsolutePath(applicationData, platform)
    : path.join(home, ".config");
  return path.join(base, "auto-mode-gate", "config.json");
}

function parseGlobalConfig(value: unknown, platform: NodeJS.Platform): GlobalFileConfig {
  if (value === undefined) {
    return {
      mode: "enforce",
      trustedExecutablePaths: [],
      permissionJudge: disabledPermissionJudge(),
    };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "mode",
      "shell",
      "trustedExecutablePaths",
      "logPath",
      "permissionJudge",
    ])
  ) {
    throw new Error("Invalid global configuration.");
  }

  const mode = readMode(value.mode);
  const shell = value.shell === undefined ? undefined : readShell(value.shell);
  const trustedExecutablePaths = readPaths(value.trustedExecutablePaths, platform);
  const logPath =
    value.logPath === undefined ? undefined : readAbsolutePath(value.logPath, platform);
  const permissionJudge = readGlobalPermissionJudge(value.permissionJudge);
  return { mode, shell, trustedExecutablePaths, logPath, permissionJudge };
}

function parseProjectConfig(
  value: unknown,
  platform: NodeJS.Platform,
): ProjectFileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "trustedExecutablePaths", "permissionJudge"])
  ) {
    throw new Error("Invalid project configuration.");
  }

  const judgePolicy = readProjectPermissionJudge(value.permissionJudge);
  return {
    gateConfig: {
      mode: value.mode === undefined ? undefined : readMode(value.mode),
      trustedExecutablePaths:
        value.trustedExecutablePaths === undefined
          ? undefined
          : readPaths(value.trustedExecutablePaths, platform),
    },
    ...judgePolicy,
  };
}

function readGlobalPermissionJudge(value: unknown): PermissionJudgeAuthorization {
  try {
    if (value === undefined) {
      return disabledPermissionJudge();
    }
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["enabled", "model", "timeoutMs"]) ||
      value.enabled !== true ||
      !isRecord(value.model) ||
      !hasOnlyKeys(value.model, ["provider", "id"])
    ) {
      return disabledPermissionJudge();
    }

    const defaultModel = createPermissionJudgeModelReference(
      value.model.provider,
      value.model.id,
    );
    const timeoutMs = readJudgeTimeout(value.timeoutMs);
    if (!defaultModel || timeoutMs === undefined) {
      return disabledPermissionJudge();
    }
    return Object.freeze({ authorized: true, defaultModel, timeoutMs });
  } catch {
    return disabledPermissionJudge();
  }
}

function readProjectPermissionJudge(value: unknown): Omit<ProjectFileConfig, "gateConfig"> {
  if (value === undefined) {
    return { judgeDisabled: false };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["enabled", "timeoutMs"]) ||
    (value.enabled !== undefined && value.enabled !== false)
  ) {
    return { judgeDisabled: true };
  }

  const timeoutMs =
    value.timeoutMs === undefined ? undefined : readJudgeTimeout(value.timeoutMs);
  if (value.timeoutMs !== undefined && timeoutMs === undefined) {
    return { judgeDisabled: true };
  }
  return {
    judgeDisabled: value.enabled === false,
    judgeTimeoutMs: timeoutMs,
  };
}

function resolvePermissionJudge(
  global: PermissionJudgeAuthorization,
  project?: ProjectFileConfig,
): PermissionJudgeAuthorization {
  if (!global.authorized || project?.judgeDisabled) {
    return disabledPermissionJudge();
  }
  if (
    project?.judgeTimeoutMs !== undefined &&
    project.judgeTimeoutMs > global.timeoutMs
  ) {
    return disabledPermissionJudge();
  }
  return Object.freeze({
    authorized: true,
    defaultModel: global.defaultModel,
    timeoutMs: project?.judgeTimeoutMs ?? global.timeoutMs,
  });
}

function readJudgeTimeout(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PERMISSION_JUDGE_TIMEOUT_MS &&
    value <= MAX_PERMISSION_JUDGE_TIMEOUT_MS
    ? value
    : undefined;
}

function disabledPermissionJudge(): PermissionJudgeAuthorization {
  return Object.freeze({ authorized: false });
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
    value.length > MAX_TRUSTED_EXECUTABLE_PATHS ||
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

function assertExistingDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Configured host root is not a regular directory.");
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

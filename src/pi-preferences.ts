import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";

import { createPermissionJudgeModelReference } from "./session.ts";
import type {
  PermissionJudgeThinking,
  PiJudgePreferencesV1,
  PiJudgeShortcuts,
} from "./types.ts";

const MAX_PREFERENCES_BYTES = 65_536;
const MAX_SHORTCUT_LENGTH = 64;
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const NAMED_KEYS = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$",
  "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const RESERVED_SHORTCUTS = new Set([
  "ctrl+c",
  "ctrl+d",
  "ctrl+g",
  "ctrl+l",
  "ctrl+o",
  "ctrl+p",
  "ctrl+r",
  "ctrl+s",
  "ctrl+t",
  "ctrl+x",
  "ctrl+shift+f",
  "ctrl+shift+g",
  "ctrl+shift+p",
  "shift+tab",
]);
const THINKING_LEVELS = new Set<PermissionJudgeThinking>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const PI_JUDGE_PREFERENCES_NAME = "auto-mode-gate-preferences.json";
export const DEFAULT_PI_JUDGE_SHORTCUTS: PiJudgeShortcuts = Object.freeze({
  menu: "ctrl+alt+g",
  toggleAuto: "ctrl+alt+a",
});

export interface PiPreferencesLoadResult {
  readonly preferences: PiJudgePreferencesV1;
  readonly warning?: "invalid-or-unreadable";
}

export interface PiPreferenceRepository {
  load(): PiPreferencesLoadResult;
  save(preferences: PiJudgePreferencesV1): void;
}

export interface PiPreferencesFileOperations {
  lstat(path: string): Stats;
  open(path: string, flags: number, mode?: number): number;
  fstat(descriptor: number): Stats;
  read(
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  close(descriptor: number): void;
  mkdir(path: string, options: { recursive: true; mode: number }): string | undefined;
  write(descriptor: number, buffer: Buffer, offset: number, length: number): number;
  fsync(descriptor: number): void;
  rename(oldPath: string, newPath: string): void;
  unlink(path: string): void;
  randomBytes(size: number): Buffer;
}

export const nodePiPreferencesFileOperations: PiPreferencesFileOperations = Object.freeze({
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
  mkdir: mkdirSync,
  write: writeSync,
  fsync: fsyncSync,
  rename: renameSync,
  unlink: unlinkSync,
  randomBytes,
});

export function createDefaultPiJudgePreferences(): PiJudgePreferencesV1 {
  return freezePreferences({
    version: 1,
    autoEnabled: false,
    shortcuts: DEFAULT_PI_JUDGE_SHORTCUTS,
  });
}

export function createMemoryPiPreferenceRepository(
  initial: PiJudgePreferencesV1 = createDefaultPiJudgePreferences(),
): PiPreferenceRepository {
  let current = parsePiJudgePreferences(initial);
  return Object.freeze({
    load: () => Object.freeze({ preferences: current }),
    save(preferences: PiJudgePreferencesV1) {
      current = parsePiJudgePreferences(preferences);
    },
  });
}

export function createUnavailablePiPreferenceRepository(): PiPreferenceRepository {
  return Object.freeze({
    load: () => Object.freeze({
      preferences: createDefaultPiJudgePreferences(),
      warning: "invalid-or-unreadable" as const,
    }),
    save() {
      throw new Error("Pi preferences path is unavailable.");
    },
  });
}

export function createFilePiPreferenceRepository(
  path: string,
  operations: PiPreferencesFileOperations = nodePiPreferencesFileOperations,
): PiPreferenceRepository {
  return Object.freeze({
    load() {
      try {
        const result = readPreferencesFile(path, operations);
        return Object.freeze({
          preferences: result.found
            ? parsePiJudgePreferences(result.value)
            : createDefaultPiJudgePreferences(),
        });
      } catch {
        return Object.freeze({
          preferences: createDefaultPiJudgePreferences(),
          warning: "invalid-or-unreadable" as const,
        });
      }
    },
    save(preferences: PiJudgePreferencesV1) {
      const snapshot = parsePiJudgePreferences(preferences);
      const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      if (bytes.length > MAX_PREFERENCES_BYTES) {
        throw new Error("Preferences are too large.");
      }
      replacePreferencesFile(path, bytes, operations);
    },
  });
}

export function parsePiJudgePreferences(value: unknown): PiJudgePreferencesV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "autoEnabled", "model", "thinking", "shortcuts"]) ||
    value.version !== 1 ||
    typeof value.autoEnabled !== "boolean" ||
    !isRecord(value.shortcuts) ||
    !hasOnlyKeys(value.shortcuts, ["menu", "toggleAuto"])
  ) {
    throw new Error("Invalid Pi permission judge preferences.");
  }

  const model = value.model === undefined
    ? undefined
    : isRecord(value.model) && hasOnlyKeys(value.model, ["provider", "id"])
      ? createPermissionJudgeModelReference(value.model.provider, value.model.id)
      : undefined;
  if (value.model !== undefined && !model) {
    throw new Error("Invalid Pi permission judge model preference.");
  }

  const thinking = value.thinking === undefined
    ? undefined
    : readThinking(value.thinking);
  const shortcuts = Object.freeze({
    menu: readShortcut(value.shortcuts.menu),
    toggleAuto: readShortcut(value.shortcuts.toggleAuto),
  });
  if (shortcuts.menu === shortcuts.toggleAuto) {
    throw new Error("Pi permission judge shortcuts must be distinct.");
  }

  return freezePreferences({
    version: 1,
    autoEnabled: value.autoEnabled,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    shortcuts,
  });
}

function replacePreferencesFile(
  path: string,
  bytes: Buffer,
  operations: PiPreferencesFileOperations,
): void {
  const directory = dirname(path);
  assertSafeAncestors(path, operations);
  operations.mkdir(directory, { recursive: true, mode: 0o700 });
  assertSafeAncestors(path, operations);
  assertReplaceableDestination(path, operations);

  const temporaryPath = `${path}.tmp-${process.pid}-${operations.randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  let primaryError: unknown;
  try {
    descriptor = operations.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    writeAll(descriptor, bytes, operations);
    operations.fsync(descriptor);
    operations.close(descriptor);
    descriptor = undefined;

    const verifiedTemporary = readPreferencesFile(temporaryPath, operations);
    if (!verifiedTemporary.found || !verifiedTemporary.bytes.equals(bytes)) {
      throw new Error("Preferences temporary file could not be verified.");
    }
    parsePiJudgePreferences(verifiedTemporary.value);

    operations.rename(temporaryPath, path);
    temporaryExists = false;
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      operations.close(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryExists) {
    try {
      operations.unlink(temporaryPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length === 0) throw primaryError;
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Preferences operation and cleanup both failed.",
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Preferences operation cleanup failed.");
  }
}

function readPreferencesFile(
  path: string,
  operations: PiPreferencesFileOperations,
): { found: false } | { found: true; bytes: Buffer; value: unknown } {
  assertSafeAncestors(path, operations);
  let descriptor: number | undefined;
  let result: { found: true; bytes: Buffer; value: unknown } | undefined;
  let missing = false;
  let primaryError: unknown;
  try {
    const pathStat = operations.lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Preferences path is not a regular file.");
    }
    descriptor = operations.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStat = operations.fstat(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      throw new Error("Preferences path changed while it was being opened.");
    }
    const bytes = readBounded(descriptor, operations);
    result = { found: true, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    if (isCode(error, "ENOENT")) missing = true;
    else primaryError = error;
  }

  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      operations.close(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined) {
    if (cleanupError === undefined) throw primaryError;
    throw new AggregateError(
      [primaryError, cleanupError],
      "Preferences read and cleanup both failed.",
    );
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (result) return result;
  if (missing) return { found: false };
  throw new Error("Preferences read did not produce a result.");
}

function readBounded(
  descriptor: number,
  operations: PiPreferencesFileOperations,
): Buffer {
  const buffer = Buffer.allocUnsafe(MAX_PREFERENCES_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = operations.read(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_PREFERENCES_BYTES) {
    throw new Error("Preferences file is too large.");
  }
  return Buffer.from(buffer.subarray(0, offset));
}

function writeAll(
  descriptor: number,
  bytes: Buffer,
  operations: PiPreferencesFileOperations,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = operations.write(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("Preferences write made no progress.");
    offset += written;
  }
}

function assertReplaceableDestination(
  path: string,
  operations: PiPreferencesFileOperations,
): void {
  try {
    const stat = operations.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Preferences destination is not a regular file.");
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function assertSafeAncestors(path: string, operations: PiPreferencesFileOperations): void {
  if (!isAbsolute(path)) throw new Error("Preferences path must be absolute.");
  const root = parse(path).root;
  const directories: string[] = [];
  for (let current = dirname(path); current !== root; current = dirname(current)) {
    directories.push(current);
  }
  if (root) directories.push(root);

  for (const directory of directories.reverse()) {
    try {
      const stat = operations.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Preferences ancestor is not a regular directory.");
      }
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

function readThinking(value: unknown): PermissionJudgeThinking {
  if (typeof value === "string" && THINKING_LEVELS.has(value as PermissionJudgeThinking)) {
    return value as PermissionJudgeThinking;
  }
  throw new Error("Invalid Pi permission judge thinking preference.");
}

function readShortcut(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SHORTCUT_LENGTH) {
    throw new Error("Invalid Pi permission judge shortcut.");
  }
  const normalized = value.toLowerCase();
  const plusKey = normalized === "+" || normalized.endsWith("++");
  const modifierText = plusKey
    ? normalized === "+" ? "" : normalized.slice(0, -2)
    : normalized;
  const parts = modifierText === "" ? [] : modifierText.split("+");
  if (parts.some((part) => part.length === 0)) {
    throw new Error("Invalid Pi permission judge shortcut.");
  }
  const key = plusKey ? "+" : parts.at(-1) ?? "";
  const modifiers = plusKey ? parts : parts.slice(0, -1);
  if (
    RESERVED_SHORTCUTS.has(normalized) ||
    new Set(modifiers).size !== modifiers.length ||
    modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    !isShortcutKey(key)
  ) {
    throw new Error("Invalid Pi permission judge shortcut.");
  }
  return normalized;
}

function isShortcutKey(key: string): boolean {
  return /^[a-z0-9]$/u.test(key) ||
    /^f(?:[1-9]|1[0-2])$/u.test(key) ||
    NAMED_KEYS.has(key) ||
    SYMBOL_KEYS.has(key);
}

function freezePreferences(value: PiJudgePreferencesV1): PiJudgePreferencesV1 {
  return Object.freeze({
    version: 1,
    autoEnabled: value.autoEnabled,
    ...(value.model ? { model: Object.freeze({ ...value.model }) } : {}),
    ...(value.thinking ? { thinking: value.thinking } : {}),
    shortcuts: Object.freeze({ ...value.shortcuts }),
  });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code;
}

import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, parse } from "node:path";
import { randomBytes } from "node:crypto";

const MAX_CONFIG_BYTES = 65_536;

export type ConfigValidator = (value: unknown) => void;

export function readOrMigrateConfig(
  destinationPath: string,
  legacyPath: string | (() => string | undefined) | undefined,
  validate: ConfigValidator,
): unknown {
  const destination = readConfigFile(destinationPath, validate);
  if (destination.found) {
    return destination.value;
  }

  const resolvedLegacyPath = typeof legacyPath === "function" ? legacyPath() : legacyPath;
  if (resolvedLegacyPath === undefined) {
    return undefined;
  }
  const legacy = readConfigFile(resolvedLegacyPath, validate);
  if (!legacy.found) {
    return undefined;
  }

  publishExclusive(destinationPath, legacy.bytes);
  return readRequiredConfig(destinationPath, validate);
}

function readRequiredConfig(path: string, validate: ConfigValidator): unknown {
  const result = readConfigFile(path, validate);
  if (!result.found) {
    throw new Error("Configuration publication did not produce a readable destination.");
  }
  return result.value;
}

function readConfigFile(
  path: string,
  validate: ConfigValidator,
): { found: false } | { found: true; bytes: Buffer; value: unknown } {
  assertSafeAncestors(path);
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Configuration path is not a regular file.");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStat = fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      throw new Error("Configuration path changed while it was being opened.");
    }
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONFIG_BYTES) {
      throw new Error("Configuration file is too large.");
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    const value = JSON.parse(bytes.toString("utf8"));
    validate(value);
    return { found: true, bytes, value };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { found: false };
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publishExclusive(destinationPath: string, bytes: Buffer): void {
  const directory = dirname(destinationPath);
  assertSafeAncestors(destinationPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeAncestors(destinationPath);

  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Configuration write made no progress.");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      linkSync(temporaryPath, destinationPath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    unlinkSync(temporaryPath);
    temporaryExists = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryExists) unlinkSync(temporaryPath);
  }
}

function assertSafeAncestors(path: string): void {
  const root = parse(path).root;
  const directories: string[] = [];
  for (let current = dirname(path); current !== root; current = dirname(current)) {
    directories.push(current);
  }
  if (root) directories.push(root);

  for (const directory of directories.reverse()) {
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Configuration ancestor is not a regular directory.");
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code;
}

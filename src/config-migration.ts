import { randomBytes } from "node:crypto";
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
  type Stats,
} from "node:fs";
import { dirname, parse } from "node:path";

const MAX_CONFIG_BYTES = 65_536;

export type ConfigValidator = (value: unknown) => void;

export interface ConfigFileOperations {
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
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
  randomBytes(size: number): Buffer;
}

export const nodeConfigFileOperations: ConfigFileOperations = Object.freeze({
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
  mkdir: mkdirSync,
  write: writeSync,
  fsync: fsyncSync,
  link: linkSync,
  unlink: unlinkSync,
  randomBytes,
});

export function readOrMigrateConfig(
  destinationPath: string,
  legacyPath: string | (() => string | undefined) | undefined,
  validate: ConfigValidator,
  operations: ConfigFileOperations = nodeConfigFileOperations,
): unknown {
  const destination = readConfigFile(destinationPath, validate, operations);
  if (destination.found) {
    return destination.value;
  }

  const resolvedLegacyPath = typeof legacyPath === "function" ? legacyPath() : legacyPath;
  if (resolvedLegacyPath === undefined) {
    return undefined;
  }
  const legacy = readConfigFile(resolvedLegacyPath, validate, operations);
  if (!legacy.found) {
    return undefined;
  }

  publishExclusive(destinationPath, legacy.bytes, operations);
  return readRequiredConfig(destinationPath, validate, operations);
}

function readRequiredConfig(
  path: string,
  validate: ConfigValidator,
  operations: ConfigFileOperations,
): unknown {
  const result = readConfigFile(path, validate, operations);
  if (!result.found) {
    throw new Error("Configuration publication did not produce a readable destination.");
  }
  return result.value;
}

function readConfigFile(
  path: string,
  validate: ConfigValidator,
  operations: ConfigFileOperations,
): { found: false } | { found: true; bytes: Buffer; value: unknown } {
  assertSafeAncestors(path, operations);
  let descriptor: number | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    const pathStat = operations.lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Configuration path is not a regular file.");
    }
    descriptor = operations.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStat = operations.fstat(descriptor);
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
      const bytesRead = operations.read(descriptor, buffer, offset, buffer.length - offset, null);
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
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        operations.close(descriptor);
      } catch (cleanupError) {
        throwCleanupFailures(primaryFailed, primaryError, [cleanupError]);
      }
    }
  }
}

function publishExclusive(
  destinationPath: string,
  bytes: Buffer,
  operations: ConfigFileOperations,
): void {
  const directory = dirname(destinationPath);
  assertSafeAncestors(destinationPath, operations);
  operations.mkdir(directory, { recursive: true, mode: 0o700 });
  assertSafeAncestors(destinationPath, operations);

  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${operations.randomBytes(12).toString("hex")}`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    descriptor = operations.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    let offset = 0;
    while (offset < bytes.length) {
      const written = operations.write(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Configuration write made no progress.");
      offset += written;
    }
    operations.fsync(descriptor);
    operations.close(descriptor);
    descriptor = undefined;

    try {
      operations.link(temporaryPath, destinationPath);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    operations.unlink(temporaryPath);
    temporaryExists = false;
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
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
    if (cleanupErrors.length > 0) {
      throwCleanupFailures(primaryFailed, primaryError, cleanupErrors);
    }
  }
}

function throwCleanupFailures(
  primaryFailed: boolean,
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (primaryFailed) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Configuration operation and cleanup both failed.",
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, "Configuration cleanup failed.");
}

function assertSafeAncestors(path: string, operations: ConfigFileOperations): void {
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

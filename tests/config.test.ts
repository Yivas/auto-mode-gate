import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";

import {
  createShellAdapter,
  getDefaultGlobalConfigPath,
  loadAdapterOptions,
} from "../src/index.ts";

const testShell = process.platform === "win32" ? "powershell" : "bash";
const dangerousCommand =
  process.platform === "win32" ? "Remove-Item fictional-secret" : "rm fictional-secret";
const trustedRead =
  process.platform === "win32" ? "C:\\trusted\\where.exe" : "/trusted/bin/ls";
const trustedGit =
  process.platform === "win32" ? "C:\\trusted\\git.exe" : "/trusted/bin/git";
const untrustedGit =
  process.platform === "win32" ? "C:\\untrusted\\git.exe" : "/untrusted/bin/git";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-config-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  return {
    root,
    projectDirectory,
    globalConfigPath: join(root, "config.json"),
    projectConfigPath: join(projectDirectory, ".auto-mode-gate.json"),
  };
}

test("file discovery applies project tightening and writes sanitized JSONL logs", async () => {
  const fixture = await createFixture();
  const logPath = join(fixture.root, "decisions.jsonl");
  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({
      mode: "shadow",
      shell: testShell,
      trustedExecutablePaths: [trustedRead, trustedGit],
      logPath,
    }),
  );
  await writeFile(
    fixture.projectConfigPath,
    JSON.stringify({
      mode: "enforce",
      trustedExecutablePaths: [trustedRead, untrustedGit],
    }),
  );

  const adapter = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  );
  const denied = adapter.evaluate({ command: dangerousCommand }).decision;
  const allowed = adapter.evaluate({ command: trustedRead }).decision;
  const removed = adapter.evaluate({ command: `${trustedGit} rev-parse --show-toplevel` }).decision;

  assert.deepEqual(
    [denied.mode, denied.code, denied.blocked],
    ["enforce", "AMG_DENY_DANGEROUS_COMMAND", true],
  );
  assert.equal(allowed.code, "AMG_ALLOW_SAFE_COMMAND");
  assert.equal(removed.code, "AMG_DENY_AMBIGUOUS");

  const logs = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logs.length, 3);
  assert.equal(JSON.stringify(logs).includes("fictional-secret"), false);
  assert.equal(Object.hasOwn(logs[0], "command"), false);
});

test("missing or malformed configuration fails closed", async () => {
  const fixture = await createFixture();
  const missing = createShellAdapter(
    "opencode",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: "rm file" }).decision;
  assert.equal(missing.code, "AMG_DENY_UNKNOWN_ACTION");
  assert.equal(missing.blocked, true);

  await writeFile(fixture.globalConfigPath, JSON.stringify({ mode: "enforce", unexpected: true }));
  const malformed = createShellAdapter(
    "opencode",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: "rm file" }).decision;
  assert.equal(malformed.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(malformed.blocked, true);
});

test("a configured log failure blocks an otherwise allowed action", async () => {
  const fixture = await createFixture();
  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({
      mode: "enforce",
      shell: testShell,
      trustedExecutablePaths: [trustedRead],
      logPath: join(fixture.root, "missing", "decisions.jsonl"),
    }),
  );

  const decision = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: trustedRead }).decision;

  assert.equal(decision.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(decision.blocked, true);
});

test("configuration file size has an exact byte limit", async () => {
  const fixture = await createFixture();
  const config = JSON.stringify({ mode: "enforce", shell: testShell });
  const atLimit = `${config}${" ".repeat(65_536 - Buffer.byteLength(config))}`;
  assert.equal(Buffer.byteLength(atLimit), 65_536);
  await writeFile(fixture.globalConfigPath, atLimit);

  const accepted = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: dangerousCommand }).decision;
  assert.equal(accepted.code, "AMG_DENY_DANGEROUS_COMMAND");

  await writeFile(fixture.globalConfigPath, `${atLimit} `);
  const rejected = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: dangerousCommand }).decision;
  assert.equal(rejected.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(rejected.blocked, true);
});

test("trusted executable path lists have a fixed limit", async () => {
  const fixture = await createFixture();
  const extraPaths = Array.from({ length: 255 }, (_, index) =>
    process.platform === "win32"
      ? `C:\\trusted\\tool-${index}.exe`
      : `/trusted/bin/tool-${index}`,
  );
  const pathsAtLimit = [trustedRead, ...extraPaths];
  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({ mode: "enforce", shell: testShell, trustedExecutablePaths: pathsAtLimit }),
  );

  const allowed = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: trustedRead }).decision;
  assert.equal(allowed.code, "AMG_ALLOW_SAFE_COMMAND");

  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({
      mode: "enforce",
      shell: testShell,
      trustedExecutablePaths: [...pathsAtLimit, untrustedGit],
    }),
  );
  const rejected = createShellAdapter(
    "pi",
    loadAdapterOptions(fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
    }),
  ).evaluate({ command: trustedRead }).decision;
  assert.equal(rejected.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(rejected.blocked, true);
});

test("the default global path follows XDG and Windows application data", () => {
  assert.equal(
    getDefaultGlobalConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux", "/home/test"),
    posix.join("/tmp/xdg", "auto-mode-gate", "config.json"),
  );
  assert.equal(
    getDefaultGlobalConfigPath({ APPDATA: "C:\\Profiles\\Test" }, "win32", "C:\\Users\\Test"),
    win32.join("C:\\Profiles\\Test", "auto-mode-gate", "config.json"),
  );
  assert.throws(
    () => getDefaultGlobalConfigPath({ XDG_CONFIG_HOME: "." }, "linux", "/home/test"),
    /Invalid absolute path/u,
  );
  assert.throws(
    () => getDefaultGlobalConfigPath({ APPDATA: "." }, "win32", "C:\\Users\\Test"),
    /Invalid absolute path/u,
  );
});

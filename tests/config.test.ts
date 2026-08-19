import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test from "node:test";

import {
  createShellAdapter,
  getDefaultGlobalConfigPath,
  loadAdapterOptions,
} from "../src/index.ts";
import { getLegacyGlobalConfigPath } from "../src/config.ts";

const testShell = process.platform === "win32" ? "powershell" : "bash";
const dangerousCommand =
  process.platform === "win32" ? "Remove-Item fictional-secret" : "rm fictional-secret";
const trustedRead =
  process.platform === "win32" ? "C:\\trusted\\where.exe" : "/trusted/bin/ls";
const trustedGit =
  process.platform === "win32" ? "C:\\trusted\\git.exe" : "/trusted/bin/git";
const untrustedGit =
  process.platform === "win32" ? "C:\\untrusted\\git.exe" : "/untrusted/bin/git";
const fixtureRoots = new Set<string>();

test.afterEach(async () => {
  const roots = [...fixtureRoots];
  fixtureRoots.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-config-"));
  fixtureRoots.add(root);
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }),
  ).evaluate({ command: "rm file" }).decision;
  assert.equal(missing.code, "AMG_DENY_UNKNOWN_ACTION");
  assert.equal(missing.blocked, true);

  await writeFile(fixture.globalConfigPath, JSON.stringify({ mode: "enforce", unexpected: true }));
  const malformed = createShellAdapter(
    "opencode",
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }),
  ).evaluate({ command: dangerousCommand }).decision;
  assert.equal(accepted.code, "AMG_DENY_DANGEROUS_COMMAND");

  await writeFile(fixture.globalConfigPath, `${atLimit} `);
  const rejected = createShellAdapter(
    "pi",
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
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
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }),
  ).evaluate({ command: trustedRead }).decision;
  assert.equal(rejected.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(rejected.blocked, true);
});

test("permission judge authorization is global, strict, and project-monotonic", async () => {
  const fixture = await createFixture();
  const validJudge = {
    enabled: true,
    model: { provider: "fictional-provider", id: "fictional-model-v1" },
    timeoutMs: 15_000,
  };

  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({ mode: "enforce", permissionJudge: validJudge }),
  );
  assert.deepEqual(
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }).permissionJudge,
    {
      authorized: true,
      defaultModel: { provider: "fictional-provider", id: "fictional-model-v1" },
      timeoutMs: 15_000,
    },
  );

  for (const timeoutMs of [1_000, 120_000]) {
    await writeFile(
      fixture.globalConfigPath,
      JSON.stringify({
        mode: "enforce",
        permissionJudge: {
          enabled: true,
          model: { provider: "p".repeat(64), id: "@cf/moonshotai/kimi-k2.6" },
          timeoutMs,
        },
      }),
    );
    assert.deepEqual(
      loadAdapterOptions("pi", fixture.projectDirectory, {
        globalConfigPath: fixture.globalConfigPath,
        projectConfigPath: fixture.projectConfigPath,
      }).permissionJudge,
      {
        authorized: true,
        defaultModel: { provider: "p".repeat(64), id: "@cf/moonshotai/kimi-k2.6" },
        timeoutMs,
      },
    );
  }

  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({ mode: "enforce", permissionJudge: validJudge }),
  );
  await writeFile(
    fixture.projectConfigPath,
    JSON.stringify({ permissionJudge: { timeoutMs: 5_000 } }),
  );
  assert.deepEqual(
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }).permissionJudge,
    {
      authorized: true,
      defaultModel: { provider: "fictional-provider", id: "fictional-model-v1" },
      timeoutMs: 5_000,
    },
  );

  await writeFile(
    fixture.projectConfigPath,
    JSON.stringify({ permissionJudge: { enabled: false } }),
  );
  assert.deepEqual(
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }).permissionJudge,
    { authorized: false },
  );

  for (const permissionJudge of [
    { enabled: true },
    { enabled: true, model: validJudge.model, timeoutMs: 999 },
    { enabled: true, model: { provider: "", id: "model" }, timeoutMs: 1_000 },
    { enabled: true, model: { provider: "p".repeat(65), id: "model" }, timeoutMs: 1_000 },
    { enabled: true, model: { provider: "provider", id: "x".repeat(129) }, timeoutMs: 1_000 },
    { enabled: true, model: validJudge.model, timeoutMs: 120_001 },
    { enabled: true, model: validJudge.model, timeoutMs: 1_000, credential: "secret" },
  ]) {
    await writeFile(
      fixture.globalConfigPath,
      JSON.stringify({ mode: "enforce", permissionJudge }),
    );
    await writeFile(fixture.projectConfigPath, "{}");
    assert.deepEqual(
      loadAdapterOptions("pi", fixture.projectDirectory, {
        globalConfigPath: fixture.globalConfigPath,
        projectConfigPath: fixture.projectConfigPath,
      }).permissionJudge,
      { authorized: false },
    );
  }

  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({ mode: "enforce", permissionJudge: validJudge }),
  );
  for (const projectJudge of [
    { enabled: true },
    { model: validJudge.model },
    { timeoutMs: 20_000 },
    { timeoutMs: 999 },
    { unexpected: true },
  ]) {
    await writeFile(
      fixture.projectConfigPath,
      JSON.stringify({ permissionJudge: projectJudge }),
    );
    assert.deepEqual(
      loadAdapterOptions("pi", fixture.projectDirectory, {
        globalConfigPath: fixture.globalConfigPath,
        projectConfigPath: fixture.projectConfigPath,
      }).permissionJudge,
      { authorized: false },
    );
  }

  await writeFile(fixture.globalConfigPath, JSON.stringify({ mode: "enforce" }));
  await writeFile(fixture.projectConfigPath, "{}");
  assert.deepEqual(
    loadAdapterOptions("pi", fixture.projectDirectory, {
      globalConfigPath: fixture.globalConfigPath,
      projectConfigPath: fixture.projectConfigPath,
    }).permissionJudge,
    { authorized: false },
  );
});

test("an explicit project destination tightens policy without a project directory", async () => {
  const fixture = await createFixture();
  await writeFile(
    fixture.globalConfigPath,
    JSON.stringify({ mode: "shadow", shell: testShell }),
  );
  await writeFile(
    fixture.projectConfigPath,
    JSON.stringify({ mode: "enforce" }),
  );

  const decision = createShellAdapter("pi", loadAdapterOptions("pi", undefined, {
    globalConfigPath: fixture.globalConfigPath,
    projectConfigPath: fixture.projectConfigPath,
  })).evaluate({ command: dangerousCommand }).decision;

  assert.equal(decision.mode, "enforce");
  assert.equal(decision.blocked, true);
});

test("legacy configuration migrates byte for byte without replacing the source", async () => {
  const fixture = await createFixture();
  const destination = join(fixture.root, "pi-agent", "auto-mode-gate.json");
  const legacy = join(fixture.root, "legacy.json");
  const snapshot = `{\n  "mode": "enforce",\n  "shell": "${testShell}"\n}\n`;
  await writeFile(legacy, snapshot);

  const options = loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: legacy,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  });

  assert.equal(options.globalConfig?.mode, "enforce");
  assert.equal(await readFile(destination, "utf8"), snapshot);
  assert.equal(await readFile(legacy, "utf8"), snapshot);
});

test("concurrent processes publish one valid destination without residual temporaries", async () => {
  const fixture = await createFixture();
  const directory = join(fixture.root, "pi-agent");
  const destination = join(directory, "auto-mode-gate.json");
  const legacy = join(fixture.root, "legacy.json");
  const snapshot = JSON.stringify({ mode: "enforce", shell: testShell });
  await writeFile(legacy, snapshot);

  const script = [
    `import { loadAdapterOptions } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};`,
    "loadAdapterOptions('pi', undefined, { globalConfigPath: process.argv[1], legacyGlobalConfigPath: process.argv[2] });",
  ].join("\n");
  await Promise.all([
    runNode(script, destination, legacy),
    runNode(script, destination, legacy),
  ]);

  assert.equal(await readFile(destination, "utf8"), snapshot);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("an existing host destination ignores invalid legacy discovery", async () => {
  const fixture = await createFixture();
  const destination = join(fixture.root, "pi-agent", "auto-mode-gate.json");
  const projectDestination = join(fixture.root, "project-destination.json");
  await mkdir(join(fixture.root, "pi-agent"));
  await writeFile(destination, JSON.stringify({ mode: "off" }));
  await writeFile(projectDestination, "{}");

  const options = loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: ".",
    projectConfigPath: projectDestination,
    legacyProjectConfigPath: ".",
  });

  assert.equal(options.globalConfig?.mode, "off");
});

test("an existing host destination ignores legacy and remains authoritative", async () => {
  const fixture = await createFixture();
  const destination = join(fixture.root, "pi-agent", "auto-mode-gate.json");
  const legacy = join(fixture.root, "legacy.json");
  await mkdir(join(fixture.root, "pi-agent"));
  await writeFile(destination, JSON.stringify({ mode: "off" }));
  await writeFile(legacy, "{ invalid json");

  const options = loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: legacy,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  });

  assert.equal(options.globalConfig?.mode, "off");
  assert.equal(await readFile(legacy, "utf8"), "{ invalid json");
});

test("invalid legacy and invalid destinations fail closed without fallback", async () => {
  const fixture = await createFixture();
  const destination = join(fixture.root, "pi-agent", "auto-mode-gate.json");
  const legacy = join(fixture.root, "legacy.json");
  await writeFile(legacy, "{ invalid json");

  const migrated = createShellAdapter("pi", loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: legacy,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  })).evaluate({ command: dangerousCommand }).decision;
  assert.equal(migrated.code, "AMG_DENY_INTERNAL_ERROR");

  await mkdir(join(fixture.root, "pi-agent"), { recursive: true });
  await writeFile(destination, "{ invalid destination");
  await writeFile(legacy, JSON.stringify({ mode: "off" }));
  const existing = createShellAdapter("pi", loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: legacy,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  })).evaluate({ command: dangerousCommand }).decision;
  assert.equal(existing.code, "AMG_DENY_INTERNAL_ERROR");
});

test("symlink configuration sources and non-directory parents fail closed", async (t) => {
  const fixture = await createFixture();
  const target = join(fixture.root, "target.json");
  const legacy = join(fixture.root, "legacy-link.json");
  const destination = join(fixture.root, "pi-agent", "auto-mode-gate.json");
  await writeFile(target, JSON.stringify({ mode: "off" }));
  try {
    await symlink(target, legacy, "file");
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM") {
      t.skip("Creating symlinks is not permitted in this Windows environment.");
      return;
    }
    throw error;
  }

  const symlinkDecision = createShellAdapter("pi", loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: destination,
    legacyGlobalConfigPath: legacy,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  })).evaluate({ command: dangerousCommand }).decision;
  assert.equal(symlinkDecision.code, "AMG_DENY_INTERNAL_ERROR");

  const blockedParent = join(fixture.root, "not-a-directory");
  await writeFile(blockedParent, "file");
  const parentDecision = createShellAdapter("pi", loadAdapterOptions("pi", fixture.projectDirectory, {
    globalConfigPath: join(blockedParent, "auto-mode-gate.json"),
    legacyGlobalConfigPath: target,
    projectConfigPath: join(fixture.root, "missing-project.json"),
    legacyProjectConfigPath: join(fixture.root, "missing-legacy-project.json"),
  })).evaluate({ command: dangerousCommand }).decision;
  assert.equal(parentDecision.code, "AMG_DENY_INTERNAL_ERROR");
});

test("Windows legacy discovery prefers APPDATA over XDG_CONFIG_HOME", () => {
  assert.equal(
    getLegacyGlobalConfigPath(
      { XDG_CONFIG_HOME: "C:\\xdg", APPDATA: "C:\\appdata" },
      "win32",
      "C:\\Users\\Test",
    ),
    win32.join("C:\\appdata", "auto-mode-gate", "config.json"),
  );
});

function runNode(script: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, ...args], {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child migration failed with ${code}: ${stderr}`));
    });
  });
}

test("the default global path follows host-owned roots", () => {
  assert.equal(
    getDefaultGlobalConfigPath("opencode", {}, "linux", "/home/test"),
    posix.join("/home/test", ".config", "opencode", "auto-mode-gate.json"),
  );
  assert.equal(
    getDefaultGlobalConfigPath("opencode", { OPENCODE_CONFIG_DIR: "   " }, "linux", "/home/test"),
    posix.join("/home/test", ".config", "opencode", "auto-mode-gate.json"),
  );
  assert.equal(
    getDefaultGlobalConfigPath("pi", {}, "win32", "C:\\Users\\Test"),
    win32.join("C:\\Users\\Test", ".pi", "agent", "auto-mode-gate.json"),
  );
  assert.equal(
    getDefaultGlobalConfigPath("pi", { PI_CODING_AGENT_DIR: "" }, "win32", "C:\\Users\\Test"),
    win32.join("C:\\Users\\Test", ".pi", "agent", "auto-mode-gate.json"),
  );
  assert.throws(
    () => getDefaultGlobalConfigPath("opencode", { OPENCODE_CONFIG_DIR: "." }, "linux", "/home/test"),
    /Invalid absolute path/u,
  );
  assert.throws(
    () => getDefaultGlobalConfigPath("pi", { PI_CODING_AGENT_DIR: "." }, "win32", "C:\\Users\\Test"),
    /Invalid absolute path/u,
  );
});

test("configured host roots must be regular readable directories", async (t) => {
  const fixture = await createFixture();
  const hostRoot = join(fixture.root, "host-root");
  await mkdir(hostRoot);
  for (const host of ["opencode", "pi"] as const) {
    const environment = host === "opencode"
      ? { OPENCODE_CONFIG_DIR: hostRoot }
      : { PI_CODING_AGENT_DIR: hostRoot };
    assert.equal(
      getDefaultGlobalConfigPath(host, environment),
      join(hostRoot, "auto-mode-gate.json"),
    );
  }

  const fileRoot = join(fixture.root, "host-file");
  await writeFile(fileRoot, "file");
  for (const host of ["opencode", "pi"] as const) {
    const fileEnvironment = host === "opencode"
      ? { OPENCODE_CONFIG_DIR: fileRoot }
      : { PI_CODING_AGENT_DIR: fileRoot };
    assert.throws(
      () => getDefaultGlobalConfigPath(host, fileEnvironment),
      /regular directory/u,
    );
  }

  const symlinkRoot = join(fixture.root, "host-link");
  try {
    await symlink(hostRoot, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
    for (const host of ["opencode", "pi"] as const) {
      const symlinkEnvironment = host === "opencode"
        ? { OPENCODE_CONFIG_DIR: symlinkRoot }
        : { PI_CODING_AGENT_DIR: symlinkRoot };
      assert.throws(
        () => getDefaultGlobalConfigPath(host, symlinkEnvironment),
        /regular directory/u,
      );
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM") {
      t.diagnostic("Skipping host-root symlink assertion because this Windows account cannot create it.");
    } else {
      throw error;
    }
  }

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const unreadableRoot = join(fixture.root, "host-unreadable");
    await mkdir(unreadableRoot);
    await chmod(unreadableRoot, 0o000);
    t.after(() => chmod(unreadableRoot, 0o700));
    const unreadableEnvironment = { OPENCODE_CONFIG_DIR: unreadableRoot };
    const decision = createShellAdapter("opencode", loadAdapterOptions("opencode", undefined, {
      env: unreadableEnvironment,
      homeDirectory: fixture.root,
    })).evaluate({ command: dangerousCommand }).decision;
    assert.equal(decision.code, "AMG_DENY_INTERNAL_ERROR");
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createDefaultPiJudgePreferences,
  createFilePiPreferenceRepository,
  nodePiPreferencesFileOperations,
  parsePiJudgePreferences,
} from "../src/pi-preferences.ts";

const snapshotA = {
  version: 1,
  autoEnabled: true,
  model: { provider: "fictional-provider", id: "model-a" },
  thinking: "high",
  shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
} as const;
const snapshotB = {
  version: 1,
  autoEnabled: false,
  model: { provider: "fictional-provider", id: "model-b" },
  thinking: "off",
  shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
} as const;

test("Pi preferences use safe defaults and a closed versioned schema", () => {
  assert.deepEqual(createDefaultPiJudgePreferences(), {
    version: 1,
    autoEnabled: false,
    shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
  });
  assert.deepEqual(parsePiJudgePreferences(snapshotA), snapshotA);

  for (const invalid of [
    null,
    {},
    { ...snapshotA, version: 2 },
    { ...snapshotA, extra: true },
    { ...snapshotA, thinking: "ultra" },
    { ...snapshotA, model: { provider: "bad provider", id: "model" } },
    { ...snapshotA, shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+g" } },
    { ...snapshotA, shortcuts: { menu: "ctrl+c", toggleAuto: "ctrl+alt+a" } },
    { ...snapshotA, shortcuts: { menu: "ctrl++g", toggleAuto: "ctrl+alt+a" } },
  ]) {
    assert.throws(() => parsePiJudgePreferences(invalid));
  }
});

test("Pi preferences round-trip model and thinking overrides", async (t) => {
  const { path } = await fixture(t);
  const repository = createFilePiPreferenceRepository(path);

  assert.deepEqual(repository.load(), {
    preferences: createDefaultPiJudgePreferences(),
  });
  repository.save(snapshotA);
  assert.deepEqual(repository.load(), { preferences: snapshotA });
  assert.equal((await readFile(path, "utf8")).includes("fictional-provider"), true);

  const reset = {
    version: 1,
    autoEnabled: true,
    shortcuts: snapshotA.shortcuts,
  } as const;
  repository.save(reset);
  assert.deepEqual(repository.load(), { preferences: reset });
  const serialized = await readFile(path, "utf8");
  assert.equal(serialized.includes('"model"'), false);
  assert.equal(serialized.includes('"thinking"'), false);
});

test("invalid, oversized, and non-regular preference files fall back safely", async (t) => {
  const { root, path } = await fixture(t);
  const repository = createFilePiPreferenceRepository(path);

  await writeFile(path, "{ invalid json");
  assert.equal(repository.load().warning, "invalid-or-unreadable");
  assert.equal(repository.load().preferences.autoEnabled, false);

  await writeFile(path, Buffer.alloc(65_537, 0x20));
  assert.equal(repository.load().warning, "invalid-or-unreadable");

  await rm(path);
  await mkdir(path);
  assert.equal(repository.load().warning, "invalid-or-unreadable");
  assert.equal((await readdir(root)).some((name) => name.includes(".tmp-")), false);
});

test("relative preference paths fail immediately without ancestor traversal", () => {
  const repository = createFilePiPreferenceRepository("relative/preferences.json");
  assert.equal(repository.load().warning, "invalid-or-unreadable");
  assert.throws(() => repository.save(snapshotA), /absolute/iu);
});

test("a failed replacement preserves the previous preference snapshot", async (t) => {
  const { path } = await fixture(t);
  const repository = createFilePiPreferenceRepository(path);
  repository.save(snapshotA);
  const before = await readFile(path, "utf8");
  const failing = createFilePiPreferenceRepository(path, {
    ...nodePiPreferencesFileOperations,
    rename() {
      const error = new Error("fictional replacement failure");
      Object.assign(error, { code: "EACCES" });
      throw error;
    },
  });

  assert.throws(() => failing.save(snapshotB));
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(repository.load(), { preferences: snapshotA });
  assert.deepEqual(
    (await readdir(join(path, ".."))).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("failed temporary verification does not publish a new snapshot", async (t) => {
  const { path } = await fixture(t);
  const repository = createFilePiPreferenceRepository(path);
  repository.save(snapshotA);
  const before = await readFile(path, "utf8");
  const failing = createFilePiPreferenceRepository(path, {
    ...nodePiPreferencesFileOperations,
    open(candidate, flags, mode) {
      if (candidate.includes(".tmp-") && mode === undefined) {
        throw new Error("fictional verification failure");
      }
      return nodePiPreferencesFileOperations.open(candidate, flags, mode);
    },
  });

  assert.throws(() => failing.save(snapshotB), /verification failure/iu);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(repository.load(), { preferences: snapshotA });
});

test("concurrent Pi preference writers leave one complete valid snapshot", async (t) => {
  const { path } = await fixture(t);
  const script = [
    `import { createFilePiPreferenceRepository } from ${JSON.stringify(new URL("../src/pi-preferences.ts", import.meta.url).href)};`,
    "const repository = createFilePiPreferenceRepository(process.argv[1]);",
    "repository.save(JSON.parse(process.argv[2]));",
  ].join("\n");
  const results = await Promise.allSettled([
    runNode(script, path, JSON.stringify(snapshotA)),
    runNode(script, path, JSON.stringify(snapshotB)),
  ]);
  assert.equal(results.some((result) => result.status === "fulfilled"), true);

  const final = createFilePiPreferenceRepository(path).load();
  assert.equal(final.warning, undefined);
  assert.equal(
    JSON.stringify(final.preferences) === JSON.stringify(snapshotA) ||
      JSON.stringify(final.preferences) === JSON.stringify(snapshotB),
    true,
  );
  assert.deepEqual(
    (await readdir(join(path, ".."))).filter((name) => name.includes(".tmp-")),
    [],
  );
});

async function fixture(t: TestContext): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-pi-preferences-"));
  await mkdir(join(root, "pi-agent"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "pi-agent", "auto-mode-gate-preferences.json") };
}

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
      else reject(new Error(`Child preference writer failed with ${code}: ${stderr}`));
    });
  });
}

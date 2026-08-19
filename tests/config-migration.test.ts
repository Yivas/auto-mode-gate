import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  nodeConfigFileOperations,
  readOrMigrateConfig,
  type ConfigFileOperations,
} from "../src/config-migration.ts";
import { createShellAdapter, loadAdapterOptions } from "../src/index.ts";

const validConfig = JSON.stringify({
  mode: "off",
  shell: process.platform === "win32" ? "powershell" : "bash",
});
const dangerousCommand = process.platform === "win32" ? "Remove-Item file" : "rm file";

function createFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "auto-mode-gate-migration-"));
  const destination = join(root, "host", "auto-mode-gate.json");
  const legacy = join(root, "legacy.json");
  writeFileSync(legacy, validConfig);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, destination, legacy };
}

function validateConfig(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid test configuration.");
  }
}

function temporaryFiles(destination: string): string[] {
  const directory = dirname(destination);
  try {
    return readdirSync(directory).filter((name) => name.includes(".tmp-"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
}

function syntheticError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Synthetic ${code}`), { code });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code;
}

test("destination and legacy entries must be readable regular files", (t) => {
  const destinationDirectory = createFixture(t);
  mkdirSync(destinationDirectory.destination, { recursive: true });
  assert.throws(
    () => readOrMigrateConfig(
      destinationDirectory.destination,
      destinationDirectory.legacy,
      validateConfig,
    ),
    /regular file/u,
  );

  const destinationSymlink = createFixture(t);
  mkdirSync(dirname(destinationSymlink.destination), { recursive: true });
  const destinationTarget = join(destinationSymlink.root, "destination-target.json");
  writeFileSync(destinationTarget, validConfig);
  try {
    symlinkSync(destinationTarget, destinationSymlink.destination, "file");
    assert.throws(
      () => readOrMigrateConfig(
        destinationSymlink.destination,
        destinationSymlink.legacy,
        validateConfig,
      ),
      /regular file/u,
    );
  } catch (error) {
    if (isCode(error, "EPERM")) {
      t.diagnostic("Skipping destination symlink assertion because this Windows account cannot create it.");
    } else {
      throw error;
    }
  }

  const legacyDirectory = createFixture(t);
  rmSync(legacyDirectory.legacy);
  mkdirSync(legacyDirectory.legacy);
  assert.throws(
    () => readOrMigrateConfig(legacyDirectory.destination, legacyDirectory.legacy, validateConfig),
    /regular file/u,
  );

  const oversized = createFixture(t);
  writeFileSync(oversized.legacy, `${validConfig}${" ".repeat(65_537)}`);
  assert.throws(
    () => readOrMigrateConfig(oversized.destination, oversized.legacy, validateConfig),
    /too large/u,
  );

  const unreadable = createFixture(t);
  const operations: ConfigFileOperations = {
    ...nodeConfigFileOperations,
    open(path, flags, mode) {
      if (path === unreadable.legacy) throw syntheticError("EACCES");
      return nodeConfigFileOperations.open(path, flags, mode);
    },
  };
  assert.throws(
    () => readOrMigrateConfig(unreadable.destination, unreadable.legacy, validateConfig, operations),
    /Synthetic EACCES/u,
  );
});

test("ancestor symlinks and file replacement during open fail closed", (t) => {
  const ancestor = createFixture(t);
  const realDirectory = join(ancestor.root, "real-host");
  const linkedDirectory = join(ancestor.root, "linked-host");
  mkdirSync(realDirectory);
  try {
    symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (isCode(error, "EPERM")) {
      t.diagnostic("Skipping ancestor symlink assertion because this Windows account cannot create it.");
    } else {
      throw error;
    }
  }
  if (readdirSync(ancestor.root).includes("linked-host")) {
    assert.throws(
      () => readOrMigrateConfig(
        join(linkedDirectory, "auto-mode-gate.json"),
        ancestor.legacy,
        validateConfig,
      ),
      /ancestor/u,
    );
  }

  const replaced = createFixture(t);
  let replacedLegacy = false;
  const operations: ConfigFileOperations = {
    ...nodeConfigFileOperations,
    open(path, flags, mode) {
      if (path === replaced.legacy && !replacedLegacy) {
        replacedLegacy = true;
        renameSync(replaced.legacy, `${replaced.legacy}.original`);
        writeFileSync(replaced.legacy, validConfig);
      }
      return nodeConfigFileOperations.open(path, flags, mode);
    },
  };
  assert.throws(
    () => readOrMigrateConfig(replaced.destination, replaced.legacy, validateConfig, operations),
    /changed while it was being opened/u,
  );
  assert.equal(temporaryFiles(replaced.destination).length, 0);
});

test("migration failures fail closed and remove temporary files when cleanup is available", async (t) => {
  const stages: readonly {
    name: string;
    override(
      fixture: ReturnType<typeof createFixture>,
      state: { temporaryDescriptor?: number; closeFailed: boolean },
    ): Partial<ConfigFileOperations>;
  }[] = [
    {
      name: "mkdir",
      override: () => ({ mkdir: () => { throw syntheticError("EACCES"); } }),
    },
    {
      name: "temporary open",
      override: () => ({
        open(path, flags, mode) {
          if (path.includes(".tmp-")) throw syntheticError("EACCES");
          return nodeConfigFileOperations.open(path, flags, mode);
        },
      }),
    },
    {
      name: "write",
      override: () => ({ write: () => { throw syntheticError("EIO"); } }),
    },
    {
      name: "fsync",
      override: () => ({ fsync: () => { throw syntheticError("EIO"); } }),
    },
    {
      name: "close",
      override: (_fixture, state) => ({
        open(path, flags, mode) {
          const descriptor = nodeConfigFileOperations.open(path, flags, mode);
          if (path.includes(".tmp-")) state.temporaryDescriptor = descriptor;
          return descriptor;
        },
        close(descriptor) {
          if (descriptor === state.temporaryDescriptor && !state.closeFailed) {
            state.closeFailed = true;
            throw syntheticError("EIO");
          }
          nodeConfigFileOperations.close(descriptor);
        },
      }),
    },
    {
      name: "publication",
      override: () => ({ link: () => { throw syntheticError("EPERM"); } }),
    },
  ];

  for (const stage of stages) {
    await t.test(stage.name, (t) => {
      const fixture = createFixture(t);
      const state = { closeFailed: false };
      const operations: ConfigFileOperations = {
        ...nodeConfigFileOperations,
        ...stage.override(fixture, state),
      };
      assert.throws(
        () => readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig, operations),
      );
      assert.equal(temporaryFiles(fixture.destination).length, 0);
      assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
    });
  }
});

test("primary and cleanup failures remain available for diagnosis", (t) => {
  const fixture = createFixture(t);
  let temporaryDescriptor: number | undefined;
  const operations: ConfigFileOperations = {
    ...nodeConfigFileOperations,
    open(path, flags, mode) {
      const descriptor = nodeConfigFileOperations.open(path, flags, mode);
      if (path.includes(".tmp-")) temporaryDescriptor = descriptor;
      return descriptor;
    },
    write() {
      throw syntheticError("WRITE_FAILURE");
    },
    close(descriptor) {
      nodeConfigFileOperations.close(descriptor);
      if (descriptor !== temporaryDescriptor) return;
      throw syntheticError("CLOSE_FAILURE");
    },
    unlink(path) {
      nodeConfigFileOperations.unlink(path);
      throw syntheticError("UNLINK_FAILURE");
    },
  };

  assert.throws(
    () => readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig, operations),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry) => (entry as NodeJS.ErrnoException).code),
        ["WRITE_FAILURE", "CLOSE_FAILURE", "UNLINK_FAILURE"],
      );
      return true;
    },
  );
  assert.equal(temporaryFiles(fixture.destination).length, 0);
  assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
});

test("cleanup failure blocks even after exclusive publication", (t) => {
  const fixture = createFixture(t);
  const operations: ConfigFileOperations = {
    ...nodeConfigFileOperations,
    unlink(path) {
      if (path.includes(".tmp-")) throw syntheticError("EACCES");
      nodeConfigFileOperations.unlink(path);
    },
  };

  assert.throws(
    () => readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig, operations),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry) => (entry as NodeJS.ErrnoException).code),
        ["EACCES", "EACCES"],
      );
      return true;
    },
  );
  assert.equal(readFileSync(fixture.destination, "utf8"), validConfig);
  assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
  assert.equal(temporaryFiles(fixture.destination).length, 1);
  assert.deepEqual(
    readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig),
    JSON.parse(validConfig),
  );
});

test("a racing invalid winner is never replaced or downgraded to legacy", (t) => {
  const fixture = createFixture(t);
  const operations: ConfigFileOperations = {
    ...nodeConfigFileOperations,
    link(_temporaryPath, destinationPath) {
      writeFileSync(destinationPath, "{ invalid winner");
      throw syntheticError("EEXIST");
    },
  };

  assert.throws(
    () => readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig, operations),
  );
  assert.equal(readFileSync(fixture.destination, "utf8"), "{ invalid winner");
  assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
  assert.equal(temporaryFiles(fixture.destination).length, 0);
});

test("migration is idempotent and repeats after only the destination is removed", (t) => {
  const fixture = createFixture(t);
  assert.deepEqual(
    readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig),
    JSON.parse(validConfig),
  );
  writeFileSync(fixture.legacy, JSON.stringify({ mode: "enforce" }));
  assert.deepEqual(
    readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig),
    JSON.parse(validConfig),
  );

  rmSync(fixture.destination);
  assert.deepEqual(
    readOrMigrateConfig(fixture.destination, fixture.legacy, validateConfig),
    { mode: "enforce" },
  );
  assert.equal(readFileSync(fixture.destination, "utf8"), JSON.stringify({ mode: "enforce" }));
});

test("OpenCode and Pi can copy one legacy file into separate destinations", (t) => {
  const fixture = createFixture(t);
  const openCodeDestination = join(fixture.root, "opencode", "auto-mode-gate.json");
  const piDestination = join(fixture.root, "pi", "auto-mode-gate.json");

  const openCode = loadAdapterOptions("opencode", undefined, {
    globalConfigPath: openCodeDestination,
    legacyGlobalConfigPath: fixture.legacy,
  });
  const pi = loadAdapterOptions("pi", undefined, {
    globalConfigPath: piDestination,
    legacyGlobalConfigPath: fixture.legacy,
  });

  assert.equal(openCode.globalConfig?.mode, "off");
  assert.equal(pi.globalConfig?.mode, "off");
  assert.equal(readFileSync(openCodeDestination, "utf8"), validConfig);
  assert.equal(readFileSync(piDestination, "utf8"), validConfig);
  assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
});

test("a published global migration remains when project migration fails", (t) => {
  const fixture = createFixture(t);
  const projectDestination = join(fixture.root, "project", ".pi", "auto-mode-gate.json");
  const invalidProjectLegacy = join(fixture.root, "project", ".auto-mode-gate.json");
  mkdirSync(dirname(invalidProjectLegacy), { recursive: true });
  writeFileSync(invalidProjectLegacy, "{ invalid project");

  const options = loadAdapterOptions("pi", dirname(invalidProjectLegacy), {
    globalConfigPath: fixture.destination,
    legacyGlobalConfigPath: fixture.legacy,
    projectConfigPath: projectDestination,
    legacyProjectConfigPath: invalidProjectLegacy,
  });
  const decision = createShellAdapter("pi", options).evaluate({ command: dangerousCommand }).decision;

  assert.equal(decision.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(readFileSync(fixture.destination, "utf8"), validConfig);
  assert.equal(readFileSync(fixture.legacy, "utf8"), validConfig);
});

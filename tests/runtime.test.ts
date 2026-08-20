import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AutoModeGatePlugin } from "../src/opencode-runtime.ts";
import { createConfiguredPiExtension } from "../src/pi-runtime.ts";
import type {
  OpenCodeToolBeforeInput,
  PiExtensionCommand,
  PiExtensionContext,
  PiModel,
  PiToolCallBlock,
  PiToolCallEvent,
} from "../src/index.ts";

const testShell = process.platform === "win32" ? "powershell" : "bash";
const dangerousCommand = process.platform === "win32" ? "Remove-Item file" : "rm file";
const trustedRead =
  process.platform === "win32" ? "C:\\trusted\\where.exe" : "/trusted/bin/ls";
const trustedGit =
  process.platform === "win32" ? "C:\\trusted\\git.exe" : "/trusted/bin/git";

test("package manifest exposes the OpenCode and Pi runtime entries", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    readonly version: string;
    readonly private?: boolean;
    readonly exports: Readonly<Record<string, string>>;
    readonly pi: { readonly extensions: readonly string[] };
  };

  assert.equal(manifest.version, "0.4.1");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.exports["./server"], "./src/opencode-runtime.ts");
  assert.deepEqual(manifest.pi.extensions, ["./src/pi-runtime.ts"]);
});

test("configured Pi runtime still registers fail-closed when its root is invalid", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-invalid-pi-root-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "missing-root");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const extension = createConfiguredPiExtension();
  const handler = registerPiHandler(extension);
  const result = await handler(
    piEvent("bash", { command: dangerousCommand }),
    { cwd: root },
  );
  assert.match(result?.reason ?? "", /AMG_DENY_INTERNAL_ERROR/u);
});

test("configured Pi runtime restores only the global preference file", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-runtime-preferences-");
  const hostRoots = await useHostRoots(t, root);
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  const judgeModel: PiModel = {
    provider: "fictional-provider",
    id: "judge-model",
    reasoning: true,
  };
  await writeFile(join(hostRoots.pi, "auto-mode-gate.json"), JSON.stringify({
    mode: "enforce",
    shell: testShell,
    permissionJudge: {
      enabled: true,
      model: { provider: judgeModel.provider, id: judgeModel.id },
      timeoutMs: 15_000,
    },
  }));
  await writeFile(join(hostRoots.pi, "auto-mode-gate-preferences.json"), JSON.stringify({
    version: 1,
    autoEnabled: true,
    thinking: "inherit",
    shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
  }));
  await writeFile(join(project, ".pi", "auto-mode-gate-preferences.json"), JSON.stringify({
    version: 1,
    autoEnabled: false,
    shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
  }));

  const command = registerPiCommand(createConfiguredPiExtension());
  const notifications: string[] = [];
  await command.handler("status", {
    cwd: project,
    sessionManager: {},
    modelRegistry: {
      getAvailable: () => [judgeModel],
      find: (provider, id) => provider === judgeModel.provider && id === judgeModel.id
        ? judgeModel
        : undefined,
    },
    scopedModels: [],
    ui: { notify(message) { notifications.push(message); } },
  });
  assert.match(notifications.at(-1) ?? "", /enabled/iu);
});

test("configured OpenCode and Pi runtimes honor host activation, modes, and precedence", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-runtime-");
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  const shadowProject = join(root, "shadow-project");
  const enforceProject = join(root, "enforce-project");
  const logPath = join(root, "decisions.jsonl");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(shadowProject);
  await mkdir(enforceProject);
  useXdgConfig(t, xdgConfigHome);
  const hostRoots = await useHostRoots(t, root);

  await writeHostGlobals(hostRoots, { mode: "shadow", shell: "bash", logPath });
  await mkdir(join(enforceProject, ".pi"));
  await writeFile(join(enforceProject, ".pi", "auto-mode-gate.json"), JSON.stringify({ mode: "enforce" }));

  const openCodeHooks = await AutoModeGatePlugin({ directory: shadowProject });
  await openCodeHooks["tool.execute.before"](
    openCodeInput("bash"),
    { args: { command: "rm fictional-open-code-secret" } },
  );

  const piHandler = registerPiHandler(createConfiguredPiExtension());
  const piResult = await piHandler(
    piEvent("bash", { command: "rm fictional-pi-secret" }),
    { cwd: enforceProject },
  );
  assert.match(piResult?.reason ?? "", /AMG_DENY_DANGEROUS_COMMAND/u);

  await writeFile(
    join(hostRoots.opencode, "auto-mode-gate.json"),
    JSON.stringify({ mode: "off", shell: "bash", logPath }),
  );
  const offHooks = await AutoModeGatePlugin({ directory: enforceProject });
  await offHooks["tool.execute.before"](
    openCodeInput("bash"),
    { args: { command: "rm still-not-blocked" } },
  );

  const serializedLogs = await readFile(logPath, "utf8");
  assert.equal(serializedLogs.includes("fictional-open-code-secret"), false);
  assert.equal(serializedLogs.includes("fictional-pi-secret"), false);
  assert.match(serializedLogs, /"mode":"shadow"/u);
  assert.match(serializedLogs, /"mode":"enforce"/u);
  assert.match(serializedLogs, /"mode":"off"/u);
});

test("both runtime entries preserve the complete configuration precedence", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-precedence-");
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  await mkdir(configDirectory, { recursive: true });
  useXdgConfig(t, xdgConfigHome);
  const hostRoots = await useHostRoots(t, root);

  for (const host of ["opencode", "pi"] as const) {
    const project = join(root, `${host}-project`);
    await mkdir(project);

    await writeRuntimeConfig(host, hostRoots, project,
      { mode: "shadow", shell: testShell, trustedExecutablePaths: [trustedRead, trustedGit] },
      { mode: "enforce", trustedExecutablePaths: [trustedRead] },
    );
    assert.match(
      await runtimeReason(host, project, dangerousCommand) ?? "",
      /AMG_DENY_DANGEROUS_COMMAND/u,
    );
    assert.match(
      await runtimeReason(host, project, `${trustedGit} rev-parse --show-toplevel`) ?? "",
      /AMG_DENY_AMBIGUOUS/u,
    );
    assert.equal(await runtimeReason(host, project, trustedRead), undefined);

    await writeRuntimeConfig(host, hostRoots, project,
      { mode: "enforce", shell: testShell },
      { mode: "shadow" },
    );
    assert.match(
      await runtimeReason(host, project, dangerousCommand) ?? "",
      /AMG_DENY_DANGEROUS_COMMAND/u,
    );

    await writeRuntimeConfig(host, hostRoots, project,
      { mode: "off", shell: testShell },
      { mode: "enforce" },
    );
    assert.equal(await runtimeReason(host, project, dangerousCommand), undefined);
  }
});

test("both runtime entries fail closed on malformed configuration and log errors", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-runtime-errors-");
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  await mkdir(configDirectory, { recursive: true });
  useXdgConfig(t, xdgConfigHome);
  const hostRoots = await useHostRoots(t, root);

  for (const host of ["opencode", "pi"] as const) {
    const project = join(root, `${host}-project`);
    await mkdir(project);

    await writeFile(join(hostRoots[host], "auto-mode-gate.json"), "{ invalid json");
    assert.match(await runtimeReason(host, project, "rm file") ?? "", /AMG_DENY_INTERNAL_ERROR/u);

    await writeFile(
      join(hostRoots[host], "auto-mode-gate.json"),
      JSON.stringify({
        mode: "enforce",
        shell: "bash",
        logPath: join(root, "missing", "decisions.jsonl"),
      }),
    );
    assert.match(await runtimeReason(host, project, "rm file") ?? "", /AMG_DENY_INTERNAL_ERROR/u);
  }
});

test("both runtimes sanitize migration failures before blocking", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-runtime-migration-error-");
  const legacyRoot = join(root, "legacy");
  const legacyDirectory = join(legacyRoot, "auto-mode-gate");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, "config.json"), "{ invalid legacy with fictional path");
  useLegacyRoot(t, legacyRoot);
  const hostRoots = await useHostRoots(t, root);

  for (const host of ["opencode", "pi"] as const) {
    const project = join(root, `${host}-migration-project`);
    await mkdir(project);
    const reason = await runtimeReason(host, project, dangerousCommand) ?? "";
    assert.match(reason, /AMG_DENY_INTERNAL_ERROR/u);
    assert.equal(reason.includes(root), false);
    assert.equal(reason.includes("fictional path"), false);
    assert.equal(
      await readFile(join(legacyDirectory, "config.json"), "utf8"),
      "{ invalid legacy with fictional path",
    );
    await assert.rejects(readFile(join(hostRoots[host], "auto-mode-gate.json")));
  }
});

test("configured runtimes fail closed when project context is unavailable", async (t) => {
  const root = await createTemporaryRoot(t, "auto-mode-gate-missing-context-");
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  await mkdir(configDirectory, { recursive: true });
  useXdgConfig(t, xdgConfigHome);
  await useHostRoots(t, root);
  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({ mode: "shadow", shell: "bash" }),
  );

  for (const input of [{}, { directory: "" }]) {
    const hooks = await AutoModeGatePlugin(input);
    await assert.rejects(
      hooks["tool.execute.before"](openCodeInput("bash"), { args: { command: "rm file" } }),
      /AMG_DENY_INTERNAL_ERROR/u,
    );
  }

  const piHandler = registerPiHandler(createConfiguredPiExtension());
  assert.match(
    (await piHandler(piEvent("bash", { command: "rm file" }), {}))?.reason ?? "",
    /AMG_DENY_INTERNAL_ERROR/u,
  );
});

test("OpenCode installs a fail-closed hook when its directory cannot be read", async () => {
  const input = new Proxy({}, { get: () => { throw new Error("unreadable directory"); } });
  const hooks = await AutoModeGatePlugin(input);

  await assert.rejects(
    hooks["tool.execute.before"](openCodeInput("bash"), { args: { command: "rm file" } }),
    /AMG_DENY_INTERNAL_ERROR/u,
  );
});

async function createTemporaryRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRuntimeConfig(
  host: "opencode" | "pi",
  hostRoots: Record<"opencode" | "pi", string>,
  projectDirectory: string,
  globalConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>,
): Promise<void> {
  const projectConfigDirectory = join(projectDirectory, host === "opencode" ? ".opencode" : ".pi");
  await mkdir(projectConfigDirectory, { recursive: true });
  await writeFile(join(hostRoots[host], "auto-mode-gate.json"), JSON.stringify(globalConfig));
  await writeFile(join(projectConfigDirectory, "auto-mode-gate.json"), JSON.stringify(projectConfig));
}

async function useHostRoots(
  t: TestContext,
  root: string,
): Promise<Record<"opencode" | "pi", string>> {
  const roots = {
    opencode: join(root, "opencode-config"),
    pi: join(root, "pi-agent"),
  };
  await mkdir(roots.opencode, { recursive: true });
  await mkdir(roots.pi, { recursive: true });
  const previousOpenCode = process.env.OPENCODE_CONFIG_DIR;
  const previousPi = process.env.PI_CODING_AGENT_DIR;
  process.env.OPENCODE_CONFIG_DIR = roots.opencode;
  process.env.PI_CODING_AGENT_DIR = roots.pi;
  t.after(() => {
    if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousOpenCode;
    if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPi;
  });
  return roots;
}

async function writeHostGlobals(
  roots: Record<"opencode" | "pi", string>,
  config: Record<string, unknown>,
): Promise<void> {
  await Promise.all([
    writeFile(join(roots.opencode, "auto-mode-gate.json"), JSON.stringify(config)),
    writeFile(join(roots.pi, "auto-mode-gate.json"), JSON.stringify(config)),
  ]);
}

async function runtimeReason(
  host: "opencode" | "pi",
  projectDirectory: string,
  command: string,
): Promise<string | undefined> {
  if (host === "pi") {
    const handler = registerPiHandler(createConfiguredPiExtension());
    return (await handler(piEvent("bash", { command }), { cwd: projectDirectory }))?.reason;
  }

  const hooks = await AutoModeGatePlugin({ directory: projectDirectory });
  try {
    await hooks["tool.execute.before"](openCodeInput("bash"), { args: { command } });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function useXdgConfig(t: TestContext, xdgConfigHome: string): void {
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  t.after(() => {
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
}

function useLegacyRoot(t: TestContext, legacyRoot: string): void {
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousApplicationData = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = legacyRoot;
  process.env.APPDATA = legacyRoot;
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousApplicationData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousApplicationData;
  });
}

function openCodeInput(tool: string): OpenCodeToolBeforeInput {
  return { tool, sessionID: "fictional-session", callID: "fictional-call" };
}

function piEvent(toolName: string, input: unknown): PiToolCallEvent {
  return { toolName, toolCallId: "fictional-call", input };
}

function registerPiCommand(
  extension: ReturnType<typeof createConfiguredPiExtension>,
): PiExtensionCommand {
  let command: PiExtensionCommand | undefined;
  extension({
    on() {},
    registerCommand(_name, registered) {
      command = registered;
    },
  });
  assert.ok(command);
  return command;
}

function registerPiHandler(extension: ReturnType<typeof createConfiguredPiExtension>) {
  let handler:
    | ((
        event: PiToolCallEvent,
        context: PiExtensionContext,
      ) => PiToolCallBlock | undefined | Promise<PiToolCallBlock | undefined>)
    | undefined;
  extension({
    on(event, registeredHandler) {
      if (event === "tool_call") handler = registeredHandler as typeof handler;
    },
  });
  assert.ok(handler);
  return handler;
}

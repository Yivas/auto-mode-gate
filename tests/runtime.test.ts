import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AutoModeGatePlugin } from "../src/opencode-runtime.ts";
import { createConfiguredPiExtension } from "../src/pi-runtime.ts";
import type {
  OpenCodeToolBeforeInput,
  PiExtensionContext,
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
    readonly exports: Readonly<Record<string, string>>;
    readonly pi: { readonly extensions: readonly string[] };
  };

  assert.equal(manifest.exports["./server"], "./src/opencode-runtime.ts");
  assert.deepEqual(manifest.pi.extensions, ["./src/pi-runtime.ts"]);
});

test("configured OpenCode and Pi runtimes honor host activation, modes, and precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-runtime-"));
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  const shadowProject = join(root, "shadow-project");
  const enforceProject = join(root, "enforce-project");
  const logPath = join(root, "decisions.jsonl");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(shadowProject);
  await mkdir(enforceProject);
  useXdgConfig(t, xdgConfigHome);

  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({ mode: "shadow", shell: "bash", logPath }),
  );
  await writeFile(join(enforceProject, ".auto-mode-gate.json"), JSON.stringify({ mode: "enforce" }));

  const openCodeHooks = await AutoModeGatePlugin({ directory: shadowProject });
  await openCodeHooks["tool.execute.before"](
    openCodeInput("bash"),
    { args: { command: "rm fictional-open-code-secret" } },
  );

  const piHandler = registerPiHandler(createConfiguredPiExtension());
  const piResult = piHandler(
    piEvent("bash", { command: "rm fictional-pi-secret" }),
    { cwd: enforceProject },
  );
  assert.match(piResult?.reason ?? "", /AMG_DENY_DANGEROUS_COMMAND/u);

  await writeFile(
    join(configDirectory, "config.json"),
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
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-precedence-"));
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  await mkdir(configDirectory, { recursive: true });
  useXdgConfig(t, xdgConfigHome);

  for (const host of ["opencode", "pi"] as const) {
    const project = join(root, `${host}-project`);
    await mkdir(project);

    await writeRuntimeConfig(configDirectory, project,
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

    await writeRuntimeConfig(configDirectory, project,
      { mode: "enforce", shell: testShell },
      { mode: "shadow" },
    );
    assert.match(
      await runtimeReason(host, project, dangerousCommand) ?? "",
      /AMG_DENY_DANGEROUS_COMMAND/u,
    );

    await writeRuntimeConfig(configDirectory, project,
      { mode: "off", shell: testShell },
      { mode: "enforce" },
    );
    assert.equal(await runtimeReason(host, project, dangerousCommand), undefined);
  }
});

test("both runtime entries fail closed on malformed configuration and log errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "auto-mode-gate-runtime-errors-"));
  const xdgConfigHome = join(root, "xdg");
  const configDirectory = join(xdgConfigHome, "auto-mode-gate");
  await mkdir(configDirectory, { recursive: true });
  useXdgConfig(t, xdgConfigHome);

  for (const host of ["opencode", "pi"] as const) {
    const project = join(root, `${host}-project`);
    await mkdir(project);

    await writeFile(join(configDirectory, "config.json"), "{ invalid json");
    assert.match(await runtimeReason(host, project, "rm file") ?? "", /AMG_DENY_INTERNAL_ERROR/u);

    await writeFile(
      join(configDirectory, "config.json"),
      JSON.stringify({
        mode: "enforce",
        shell: "bash",
        logPath: join(root, "missing", "decisions.jsonl"),
      }),
    );
    assert.match(await runtimeReason(host, project, "rm file") ?? "", /AMG_DENY_INTERNAL_ERROR/u);
  }
});

test("OpenCode installs a fail-closed hook when its directory cannot be read", async () => {
  const input = new Proxy({}, { get: () => { throw new Error("unreadable directory"); } });
  const hooks = await AutoModeGatePlugin(input);

  await assert.rejects(
    hooks["tool.execute.before"](openCodeInput("bash"), { args: { command: "rm file" } }),
    /AMG_DENY_INTERNAL_ERROR/u,
  );
});

async function writeRuntimeConfig(
  configDirectory: string,
  projectDirectory: string,
  globalConfig: Record<string, unknown>,
  projectConfig: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(configDirectory, "config.json"), JSON.stringify(globalConfig));
  await writeFile(join(projectDirectory, ".auto-mode-gate.json"), JSON.stringify(projectConfig));
}

async function runtimeReason(
  host: "opencode" | "pi",
  projectDirectory: string,
  command: string,
): Promise<string | undefined> {
  if (host === "pi") {
    const handler = registerPiHandler(createConfiguredPiExtension());
    return handler(piEvent("bash", { command }), { cwd: projectDirectory })?.reason;
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

function openCodeInput(tool: string): OpenCodeToolBeforeInput {
  return { tool, sessionID: "fictional-session", callID: "fictional-call" };
}

function piEvent(toolName: string, input: unknown): PiToolCallEvent {
  return { toolName, toolCallId: "fictional-call", input };
}

function registerPiHandler(extension: ReturnType<typeof createConfiguredPiExtension>) {
  let handler:
    | ((event: PiToolCallEvent, context: PiExtensionContext) => PiToolCallBlock | undefined)
    | undefined;
  extension({
    on(event, registeredHandler) {
      assert.equal(event, "tool_call");
      handler = registeredHandler;
    },
  });
  assert.ok(handler);
  return handler;
}

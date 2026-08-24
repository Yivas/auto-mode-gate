import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") {
  console.log("OpenCode host integration runs in Linux CI; Windows uses a separate manual probe.");
  process.exit(0);
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "auto-mode-gate-opencode-host-"));
const markerPath = join(temporaryRoot, "effect-marker.txt");
const opencodeCommand = process.env.OPENCODE_BIN?.trim() || "opencode";

try {
  const hostVersion = await run(opencodeCommand, ["--version"]);
  assert.equal(hostVersion.exitCode, 0, hostVersion.output);
  assert.equal(hostVersion.stdout.trim(), "1.18.18", "The host integration requires OpenCode 1.18.18.");
  const packageDirectory = await installPackedCandidate();
  const provider = await startLoopbackProvider();
  try {
    provider.reset();
    const control = await runOpenCodeProbe({
      name: "control",
      providerPort: provider.port,
    });
    assert.equal(control.exitCode, 0, control.output);
    assert.equal(
      await readOptional(markerPath),
      "ran\n",
      `The control tool call did not reach Bash (exit ${control.exitCode}).\n${control.output}`,
    );
    assert.deepEqual(provider.stats(), {
      protocolViolations: 0,
      toolCallRequests: 1,
      toolResultRequests: 1,
    });

    await rm(markerPath, { force: true });
    provider.reset();
    const protectedRun = await runOpenCodeProbe({
      name: "protected",
      providerPort: provider.port,
      plugin: pathToFileURL(packageDirectory).href,
    });
    assert.equal(protectedRun.exitCode, 0, protectedRun.output);
    assert.match(protectedRun.output, /AMG_DENY_AMBIGUOUS/u);
    assert.equal(await readOptional(markerPath), undefined, "The denied Bash effect was executed.");
    assert.deepEqual(provider.stats(), {
      protocolViolations: 0,
      toolCallRequests: 1,
      toolResultRequests: 1,
    });
  } finally {
    await provider.close();
  }

  console.log("OpenCode 1.18.18 loaded the packed plugin and blocked Bash before the probe effect.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function installPackedCandidate() {
  const packDirectory = join(temporaryRoot, "pack");
  const installRoot = join(temporaryRoot, "package-install");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(join(temporaryRoot, "npm", "home"), { recursive: true }),
  ]);

  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this integration through npm so npm_execpath is available.");
  const npmEnvironment = isolatedNpmEnvironment(join(temporaryRoot, "npm"));
  const packed = await run(process.execPath, [
    npmCli,
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
  ], { cwd: repositoryRoot, env: npmEnvironment });
  assert.equal(packed.exitCode, 0, packed.output);
  const packResult = JSON.parse(packed.stdout);
  const filename = packResult?.[0]?.filename;
  if (typeof filename !== "string" || filename === "") {
    throw new Error("npm pack did not report a candidate tarball.");
  }

  const tarballPath = join(packDirectory, filename);
  const installed = await run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarballPath,
  ], { env: npmEnvironment });
  assert.equal(installed.exitCode, 0, installed.output);

  const packageDirectory = join(installRoot, "node_modules", "auto-mode-gate");
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert.equal(manifest.name, "auto-mode-gate");
  assert.equal(manifest.exports?.["./server"], "./src/opencode-runtime.ts");
  await access(join(packageDirectory, "src", "opencode-runtime.ts"));
  return packageDirectory;
}

async function runOpenCodeProbe({ name, providerPort, plugin }) {
  const profileRoot = join(temporaryRoot, name);
  const projectDirectory = join(profileRoot, "project");
  const configDirectory = join(profileRoot, "config");
  const cacheDirectory = join(profileRoot, "cache");
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(configDirectory, { recursive: true }),
    mkdir(join(profileRoot, "home"), { recursive: true }),
    mkdir(join(profileRoot, "data"), { recursive: true }),
    mkdir(join(profileRoot, "state"), { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ]);

  const openCodeConfig = {
    model: "amg-probe/probe",
    provider: {
      "amg-probe": {
        npm: "@ai-sdk/openai-compatible",
        name: "Auto Mode Gate host probe",
        options: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "fictional-loopback-key",
        },
        models: { probe: { name: "Deterministic loopback probe" } },
      },
    },
    plugin: plugin ? [plugin] : [],
  };
  await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify(openCodeConfig), "utf8");
  await writeFile(join(configDirectory, "opencode.json"), "{}\n", "utf8");
  await writeFile(
    join(configDirectory, "auto-mode-gate.json"),
    `${JSON.stringify({ mode: "enforce", shell: "bash", trustedExecutablePaths: [] })}\n`,
    "utf8",
  );

  const probeArgs = [
    "run",
    "--auto",
    "--model",
    "amg-probe/probe",
    "Run the requested probe command exactly once.",
  ];
  return run(opencodeCommand, probeArgs, {
    cwd: projectDirectory,
    env: isolatedEnvironment(profileRoot, configDirectory, cacheDirectory),
    timeoutMs: 180_000,
    killProcessGroup: true,
  });
}

function isolatedNpmEnvironment(root) {
  return Object.assign(baseProcessEnvironment(), {
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    npm_config_cache: join(root, "cache"),
    NPM_CONFIG_USERCONFIG: join(root, "empty-npmrc"),
  });
}

function isolatedEnvironment(profileRoot, configDirectory, cacheDirectory) {
  const home = join(profileRoot, "home");
  return Object.assign(baseProcessEnvironment(), {
    HOME: home,
    USERPROFILE: home,
    AMG_PROBE_MARKER: markerPath,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: join(profileRoot, "data"),
    XDG_CACHE_HOME: cacheDirectory,
    XDG_STATE_HOME: join(profileRoot, "state"),
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  });
}

function baseProcessEnvironment() {
  const environment = {};
  for (const key of [
    "CI",
    "ComSpec",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "OS",
    "PATH",
    "Path",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "WINDIR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function startLoopbackProvider() {
  let protocolViolations = 0;
  let toolCallRequests = 0;
  let toolResultRequests = 0;
  const expectedCommand = "node -e \"require('node:fs').appendFileSync(process.env.AMG_PROBE_MARKER,'ran\\n')\"";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;

    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "probe", object: "model", created: 0, owned_by: "amg-probe" }],
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      protocolViolations += 1;
      response.writeHead(404).end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      protocolViolations += 1;
      response.writeHead(400).end();
      return;
    }
    if (payload.model !== "probe" || !Array.isArray(payload.messages)) {
      protocolViolations += 1;
      response.writeHead(400).end();
      return;
    }

    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const hasBashTool = hasTools && payload.tools.some((tool) => tool?.function?.name === "bash");
    const hasToolResult = payload.messages.some((message) => message?.role === "tool");
    if (hasTools && !hasBashTool) {
      protocolViolations += 1;
      response.writeHead(400).end();
      return;
    }
    if (hasTools && hasToolResult) toolResultRequests += 1;
    else if (hasTools) toolCallRequests += 1;

    response.setHeader("content-type", "text/event-stream");
    const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const chunk = (delta, finishReason = null) => ({
      id: "chatcmpl-amg-probe",
      object: "chat.completion.chunk",
      created: 0,
      model: "probe",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    send(chunk({ role: "assistant" }));
    if (!hasTools) {
      send(chunk({ content: "Auto Mode Gate host probe" }));
      send(chunk({}, "stop"));
    } else if (hasToolResult) {
      send(chunk({ content: "probe complete" }));
      send(chunk({}, "stop"));
    } else {
      send(chunk({
        tool_calls: [{
          index: 0,
          id: "call_amg_probe",
          type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: expectedCommand }) },
        }],
      }));
      send(chunk({}, "tool_calls"));
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback provider did not bind a port.");

  return {
    port: address.port,
    reset() {
      protocolViolations = 0;
      toolCallRequests = 0;
      toolResultRequests = 0;
    },
    stats() { return { protocolViolations, toolCallRequests, toolResultRequests }; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const killProcessGroup = options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: killProcessGroup,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let forceTimer;
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });

    const terminate = (signal) => {
      if (killProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") stderr = appendBounded(stderr, `\nProcess cleanup failed: ${error}`);
        }
      } else {
        child.kill(signal);
      }
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate("SIGTERM");
          forceTimer = setTimeout(() => terminate("SIGKILL"), 2_000);
        }, options.timeoutMs)
      : undefined;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimers();
      if (killProcessGroup) terminate(timedOut ? "SIGKILL" : "SIGTERM");
      resolve({
        exitCode: exitCode ?? 1,
        signal,
        stdout,
        stderr,
        output: `${stdout}\n${stderr}`.trim(),
      });
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > 1_000_000 ? next.slice(-1_000_000) : next;
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

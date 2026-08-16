import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AutoModeGateOpenCodePlugin,
  createOpenCodeHooks,
  createPiExtension,
  createShellAdapter,
} from "../src/index.ts";
import type {
  GateConfig,
  OpenCodeToolBeforeInput,
  PiExtensionContext,
  PiToolCallBlock,
  PiToolCallEvent,
} from "../src/index.ts";

interface Fixture {
  readonly name: string;
  readonly config?: GateConfig;
  readonly input: Record<string, unknown>;
  readonly expected: {
    readonly policyVerdict: string;
    readonly effect: string;
    readonly code: string;
    readonly blocked: boolean;
  };
}

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/conformance.json", import.meta.url), "utf8"),
) as Fixture[];

for (const host of ["opencode", "pi"] as const) {
  for (const fixture of fixtures) {
    test(`${host} adapter conformance: ${fixture.name}`, () => {
      const evaluation = createShellAdapter(host, {
        globalConfig: fixture.config,
      }).evaluate({
        shell: fixture.input.shell,
        command: fixture.input.command,
        truncated: fixture.input.truncated,
      });

      assert.deepEqual(
        {
          policyVerdict: evaluation.decision.policyVerdict,
          effect: evaluation.decision.effect,
          code: evaluation.decision.code,
          blocked: evaluation.decision.blocked,
        },
        fixture.expected,
      );
      assert.equal(
        evaluation.decision.log.host,
        fixture.expected.code === "AMG_DENY_UNKNOWN_ACTION" ? "unknown" : host,
      );
    });
  }
}

test("OpenCode blocks before a denied Bash call can run", async () => {
  const hooks = createOpenCodeHooks({ shell: "bash" });
  let effectRan = false;

  await assert.rejects(
    async () => {
      await hooks["tool.execute.before"](openCodeInput("bash"), {
        args: { command: "rm -rf build" },
      });
      effectRan = true;
    },
    /AMG_DENY_DANGEROUS_COMMAND/u,
  );
  assert.equal(effectRan, false);
});

test("OpenCode allows only an explicit trusted executable path", async () => {
  const hooks = createOpenCodeHooks({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/ls"] },
  });
  const args = { command: "/trusted/bin/ls -la" };

  await hooks["tool.execute.before"](openCodeInput("bash"), { args });

  assert.equal(args.command, "/trusted/bin/ls -la");
});

test("OpenCode reads plugin options and converts ambiguity to a safe error", async () => {
  const hooks = await AutoModeGateOpenCodePlugin({}, { shell: "bash" });

  await assert.rejects(
    hooks["tool.execute.before"](openCodeInput("bash"), {
      args: { command: "custom-tool inspect" },
    }),
    /AMG_DENY_AMBIGUOUS/u,
  );
});

test("OpenCode ignores tools outside the shell adapter scope", async () => {
  const hooks = createOpenCodeHooks();
  await hooks["tool.execute.before"](openCodeInput("read"), { args: {} });
});

test("Pi blocks before a denied Bash call can run", () => {
  const handler = registerPiHandler(createPiExtension({ shell: "bash" }));
  let effectRan = false;
  const result = handler(piEvent("bash", { command: "rm -rf build" }), { hasUI: true });
  if (!result?.block) {
    effectRan = true;
  }

  assert.match(result?.reason ?? "", /AMG_DENY_DANGEROUS_COMMAND/u);
  assert.equal(effectRan, false);
});

test("Pi allows only an explicit trusted executable path", () => {
  const handler = registerPiHandler(
    createPiExtension({
      shell: "bash",
      globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/ls"] },
    }),
  );
  const input = { command: "/trusted/bin/ls -la" };

  const result = handler(piEvent("bash", input), {});

  assert.equal(result, undefined);
  assert.equal(input.command, "/trusted/bin/ls -la");
});

test("Pi blocks ambiguity without invoking future confirmation capability", () => {
  const handler = registerPiHandler(createPiExtension({ shell: "bash" }));
  let confirmations = 0;
  const result = handler(piEvent("bash", { command: "custom-tool inspect" }), {
    hasUI: true,
    ui: { confirm: () => { confirmations += 1; return true; } },
  });

  assert.match(result?.reason ?? "", /AMG_DENY_AMBIGUOUS/u);
  assert.equal(confirmations, 0);
});

test("Pi ignores tools outside the shell adapter scope", () => {
  const handler = registerPiHandler(createPiExtension());
  assert.equal(handler(piEvent("read", { path: "file.txt" }), {}), undefined);
});

test("missing shell evidence blocks Bash calls", async () => {
  const openCode = createOpenCodeHooks();
  await assert.rejects(
    openCode["tool.execute.before"](openCodeInput("bash"), { args: { command: "rm file" } }),
    /AMG_DENY_UNKNOWN_ACTION/u,
  );

  const pi = registerPiHandler(createPiExtension());
  assert.match(
    pi(piEvent("bash", { command: "rm file" }), {})?.reason ?? "",
    /AMG_DENY_UNKNOWN_ACTION/u,
  );
});

test("adapter modes and project configuration preserve the core restrictions", () => {
  const shadow = createShellAdapter("pi", {
    shell: "bash",
    globalConfig: { mode: "shadow" },
  }).evaluate({ command: "rm file" });
  const off = createShellAdapter("opencode", {
    shell: "bash",
    globalConfig: { mode: "off" },
    projectConfig: { mode: "enforce" },
  }).evaluate({ command: "rm file" });
  const tightened = createShellAdapter("pi", {
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/ls"] },
    projectConfig: { mode: "shadow", trustedExecutablePaths: ["/untrusted/bin/ls"] },
  }).evaluate({ command: "ls" });

  assert.deepEqual(
    { mode: shadow.decision.mode, blocked: shadow.decision.blocked },
    { mode: "shadow", blocked: false },
  );
  assert.deepEqual(
    { mode: off.decision.mode, blocked: off.decision.blocked },
    { mode: "off", blocked: false },
  );
  assert.deepEqual(
    { code: tightened.decision.code, mode: tightened.decision.mode, blocked: tightened.decision.blocked },
    { code: "AMG_DENY_AMBIGUOUS", mode: "enforce", blocked: true },
  );
});

test("bare executable names fail closed", () => {
  const evaluation = createShellAdapter("opencode", {
    shell: "bash",
    globalConfig: {
      mode: "enforce",
      trustedExecutablePaths: ["/trusted/bin/ls"],
    },
  }).evaluate({ command: "ls" });

  assert.equal(evaluation.command, "ls");
  assert.equal(evaluation.decision.code, "AMG_DENY_AMBIGUOUS");
  assert.equal(evaluation.decision.blocked, true);
});

test("host input errors fail closed without exposing thrown values", async () => {
  const secret = "fictional-sensitive-error";
  const hooks = createOpenCodeHooks({ shell: "bash" });
  const unreadableArgs = new Proxy({}, { get: () => { throw new Error(secret); } });
  await assert.rejects(
    hooks["tool.execute.before"](openCodeInput("bash"), { args: unreadableArgs }),
    (error: Error) => error.message.includes("AMG_DENY_INTERNAL_ERROR") && !error.message.includes(secret),
  );

  const handler = registerPiHandler(createPiExtension({ shell: "bash" }));
  const unreadableEvent = new Proxy({}, { get: () => { throw new Error(secret); } });
  const result = handler(unreadableEvent as PiToolCallEvent, {});
  assert.match(result?.reason ?? "", /AMG_DENY_INTERNAL_ERROR/u);
  assert.equal(result?.reason.includes(secret), false);
});

function openCodeInput(tool: string): OpenCodeToolBeforeInput {
  return { tool, sessionID: "fictional-session", callID: "fictional-call" };
}

function piEvent(toolName: string, input: unknown): PiToolCallEvent {
  return { toolName, toolCallId: "fictional-call", input };
}

function registerPiHandler(extension: ReturnType<typeof createPiExtension>) {
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiExtension,
  type PiExtensionCommand,
  type PiExtensionContext,
  type PiModel,
  type PiToolCallBlock,
  type PiToolCallEvent,
} from "../src/index.ts";

const model = { provider: "fictional-provider", id: "model-a" } as const;
const authorization = {
  authorized: true,
  defaultModel: model,
  timeoutMs: 1_000,
} as const;
const eligibleCommand = "/trusted/bin/git diff --stat ./src";

interface TestAssistantMessage {
  readonly stopReason: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

interface TestCompletionContext {
  readonly systemPrompt: string;
  readonly messages: readonly {
    readonly role: "user";
    readonly content: string;
    readonly timestamp: number;
  }[];
  readonly tools: readonly [];
}

interface TestCompletionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxRetries: 0;
}

test("Pi judge transport sends one isolated request before allowing", async () => {
  let completeCalls = 0;
  let capturedContext: unknown;
  let capturedOptions: unknown;
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: {
      mode: "enforce",
      trustedExecutablePaths: ["/trusted/bin/git"],
    },
    permissionJudge: authorization,
  }));
  const context = piContext(async (_model, requestContext, options) => {
    completeCalls += 1;
    capturedContext = requestContext;
    capturedOptions = options;
    return message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}');
  });

  await runtime.command.handler("on", context);
  let effectRan = false;
  const toolEvent = event(eligibleCommand);
  const result = await runtime.handler(toolEvent, context);
  if (!result?.block) {
    effectRan = true;
  }

  assert.equal(effectRan, true);
  assert.equal(Object.isFrozen(toolEvent.input), true);
  assert.equal(completeCalls, 1);
  assert.equal(runtime.toolCalls, 1);
  assert.deepEqual(capturedOptions && {
    timeoutMs: (capturedOptions as { timeoutMs: number }).timeoutMs,
    maxRetries: (capturedOptions as { maxRetries: number }).maxRetries,
    hasSignal: (capturedOptions as { signal: unknown }).signal instanceof AbortSignal,
  }, { timeoutMs: 1_000, maxRetries: 0, hasSignal: true });
  const serialized = JSON.stringify(capturedContext);
  assert.match(serialized, /"tools":\[\]/u);
  assert.match(serialized, /"messages":\[\{"role":"user"/u);
  assert.equal(serialized.includes(eligibleCommand), false);
  assert.equal(serialized.includes("./src"), false);
});

test("Pi judge deny, tool calls, provider errors, and missing models block", async () => {
  const cases: readonly {
    readonly name: string;
    readonly complete?: () => Promise<unknown>;
    readonly available?: readonly PiModel[];
    readonly code: RegExp;
  }[] = [
    {
      name: "deny",
      complete: async () => message('{"protocol":"amg-permission-judge/v1","verdict":"deny"}'),
      code: /AMG_DENY_JUDGE/u,
    },
    {
      name: "tool call",
      complete: async () => ({
        stopReason: "toolUse",
        content: [{ type: "toolCall" }],
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "proxied content index",
      complete: async () => ({
        stopReason: "stop",
        content: new Proxy([], {
          get(target, property, receiver) {
            if (property === "length") {
              return 1;
            }
            if (property === "0") {
              return {
                type: "text",
                text: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "inherited top-level fields",
      complete: async () => Object.create({
        stopReason: "stop",
        content: [{
          type: "text",
          text: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
        }],
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "proxied content iterator",
      complete: async () => ({
        stopReason: "stop",
        content: new Proxy([], {
          get(target, property, receiver) {
            if (property === "length") {
              return 0;
            }
            if (property === Symbol.iterator) {
              return function* () {
                yield {
                  type: "text",
                  text: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
                };
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "too many content blocks",
      complete: async () => ({
        stopReason: "stop",
        content: Array.from({ length: 17 }, () => ({ type: "thinking" })),
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "malformed top-level message",
      complete: async () => Object.assign([], {
        stopReason: "stop",
        content: [{
          type: "text",
          text: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
        }],
      }),
      code: /AMG_DENY_JUDGE_INVALID_RESPONSE/u,
    },
    {
      name: "provider error",
      complete: async () => { throw new Error("fictional provider secret"); },
      code: /AMG_DENY_JUDGE_ERROR/u,
    },
    {
      name: "provider error message",
      complete: async () => ({ stopReason: "error", content: [] }),
      code: /AMG_DENY_JUDGE_ERROR/u,
    },
    {
      name: "provider aborted message",
      complete: async () => ({ stopReason: "aborted", content: [] }),
      code: /AMG_DENY_JUDGE_CANCELLED/u,
    },
    {
      name: "missing model",
      available: [],
      code: /AMG_DENY_JUDGE_UNAVAILABLE/u,
    },
  ];

  for (const fixture of cases) {
    const runtime = registerPi(createPiExtension({
      shell: "bash",
      globalConfig: {
        mode: "enforce",
        trustedExecutablePaths: ["/trusted/bin/git"],
      },
      permissionJudge: authorization,
    }));
    const context = piContext(fixture.complete, fixture.available);
    await runtime.command.handler("on", context);
    const result = await runtime.handler(event(eligibleCommand), context);

    assert.match(result?.reason ?? "", fixture.code, fixture.name);
    assert.equal(result?.reason.includes("fictional provider secret"), false);
  }
});

test("Pi cancellation blocks without contacting the model", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const context = {
    ...piContext(async () => {
      calls += 1;
      return message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}');
    }),
    signal: controller.signal,
  };

  await runtime.command.handler("on", context);
  const result = await runtime.handler(event(eligibleCommand), context);

  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_CANCELLED/u);
  assert.equal(calls, 0);
});

test("Pi in-flight cancellation wins over a late allow and finalizes once", async () => {
  const controller = new AbortController();
  let resolveCompletion: ((message: TestAssistantMessage) => void) | undefined;
  let logs = 0;
  const completion = new Promise<TestAssistantMessage>((resolve) => {
    resolveCompletion = resolve;
  });
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
    onDecision() {
      logs += 1;
    },
  }));
  const context = {
    ...piContext(async () => completion),
    signal: controller.signal,
  };
  await runtime.command.handler("on", context);

  const pending = runtime.handler(event(eligibleCommand), context);
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_CANCELLED/u);
  assert.equal(logs, 1);

  resolveCompletion?.(message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(logs, 1);
});

test("Pi blocks if input changes while the judge is pending", async () => {
  let resolveStarted: (() => void) | undefined;
  let resolveCompletion: ((message: TestAssistantMessage) => void) | undefined;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const completion = new Promise<TestAssistantMessage>((resolve) => { resolveCompletion = resolve; });
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const context = piContext(async () => {
    resolveStarted?.();
    return completion;
  });
  await runtime.command.handler("on", context);
  const input = { command: eligibleCommand };

  const pending = runtime.handler(eventWithInput(input), context);
  await started;
  input.command = "rm -rf build";
  resolveCompletion?.(message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}'));
  const result = await pending;

  assert.match(result?.reason ?? "", /AMG_DENY_INTERNAL_ERROR/u);
});

test("Pi malformed signal cleanup cannot leave a decision pending", async () => {
  const controller = new AbortController();
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "removeEventListener") {
        return () => { throw new Error("fictional cleanup failure"); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const context = {
    ...piContext(async () => message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}')),
    signal,
  };
  await runtime.command.handler("on", context);

  const result = await runtime.handler(event(eligibleCommand), context);
  assert.equal(result, undefined);
});

test("Pi local deadline ignores a late provider resolution and logs once", async () => {
  let resolveCompletion: ((message: TestAssistantMessage) => void) | undefined;
  let logs = 0;
  const completion = new Promise<TestAssistantMessage>((resolve) => {
    resolveCompletion = resolve;
  });
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
    onDecision() {
      logs += 1;
    },
  }));
  const context = piContext(async () => completion);
  await runtime.command.handler("on", context);

  const started = Date.now();
  const result = await runtime.handler(event(eligibleCommand), context);
  const elapsed = Date.now() - started;
  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_TIMEOUT/u);
  assert.ok(elapsed >= 900 && elapsed < 2_000);
  assert.equal(logs, 1);

  resolveCompletion?.(message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(logs, 1);
});

test("Pi deadline catches a synchronously blocking provider", async () => {
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const context = piContext(async () => {
    const until = Date.now() + 1_100;
    while (Date.now() < until) {
      // Simulate a provider that blocks before returning its promise.
    }
    return message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}');
  });
  await runtime.command.handler("on", context);

  const result = await runtime.handler(event(eligibleCommand), context);
  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_TIMEOUT/u);
});

test("Pi deadline is rechecked after synchronous response parsing", async () => {
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const completion: Record<string, unknown> = { stopReason: "stop" };
  Object.defineProperty(completion, "content", {
    enumerable: true,
    get() {
      const until = Date.now() + 1_100;
      while (Date.now() < until) {
        // Simulate an untrusted response object blocking during validation.
      }
      return [{
        type: "text",
        text: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
      }];
    },
  });
  const context = piContext(async () => completion);
  await runtime.command.handler("on", context);

  const result = await runtime.handler(event(eligibleCommand), context);
  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_TIMEOUT/u);
});

test("Pi deadline wins when an earlier provider callback blocks past it", async () => {
  const runtime = registerPi(createPiExtension({
    shell: "bash",
    globalConfig: { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    permissionJudge: authorization,
  }));
  const context = piContext(() => new Promise((resolve) => {
    setTimeout(() => {
      const until = Date.now() + 200;
      while (Date.now() < until) {
        // Keep the event loop busy until after the permission deadline.
      }
      resolve(message('{"protocol":"amg-permission-judge/v1","verdict":"allow"}'));
    }, 900);
  }));
  await runtime.command.handler("on", context);

  const result = await runtime.handler(event(eligibleCommand), context);
  assert.match(result?.reason ?? "", /AMG_DENY_JUDGE_TIMEOUT/u);
});

test("Pi off and shadow modes never contact the judge", async () => {
  for (const mode of ["off", "shadow"] as const) {
    let calls = 0;
    const runtime = registerPi(createPiExtension({
      shell: "bash",
      globalConfig: { mode, trustedExecutablePaths: ["/trusted/bin/git"] },
      permissionJudge: authorization,
    }));
    const context = piContext(async () => {
      calls += 1;
      return message('{"protocol":"amg-permission-judge/v1","verdict":"deny"}');
    });
    await runtime.command.handler("on", context);

    const result = await runtime.handler(event(eligibleCommand), context);
    assert.equal(result, undefined);
    assert.equal(calls, 0);
  }
});

function registerPi(extension: ReturnType<typeof createPiExtension>) {
  let handler:
    | ((
        event: PiToolCallEvent,
        context: PiExtensionContext,
      ) => PiToolCallBlock | undefined | Promise<PiToolCallBlock | undefined>)
    | undefined;
  let command: PiExtensionCommand | undefined;
  let toolRegistrations = 0;
  extension({
    on(eventName, registeredHandler) {
      assert.equal(eventName, "tool_call");
      toolRegistrations += 1;
      handler = registeredHandler;
    },
    registerCommand(name, registeredCommand) {
      assert.equal(name, "amg-judge");
      command = registeredCommand;
    },
  });
  assert.equal(toolRegistrations, 1);
  assert.ok(handler);
  assert.ok(command);
  const registeredHandler = handler;
  const registeredCommand = command;
  let toolCalls = 0;
  return {
    async handler(event: PiToolCallEvent, context: PiExtensionContext) {
      toolCalls += 1;
      return await registeredHandler(event, context);
    },
    command: registeredCommand,
    get toolCalls() {
      return toolCalls;
    },
  };
}

function piContext(
  complete: ((
    model: PiModel,
    context: TestCompletionContext,
    options: TestCompletionOptions,
  ) => Promise<unknown>) | undefined = async () => message(
    '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
  ),
  available: readonly PiModel[] = [model],
): PiExtensionContext {
  const modelRegistry = {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find(
      (candidate) => candidate.provider === provider && candidate.id === id,
    ),
    complete,
  };
  return {
    cwd: "/project",
    sessionManager: {},
    modelRegistry,
    scopedModels: [],
    ui: { notify() {} },
  };
}

function event(command: string): PiToolCallEvent {
  return eventWithInput({ command });
}

function eventWithInput(input: Record<string, unknown>): PiToolCallEvent {
  return { toolName: "bash", toolCallId: "fictional-call", input };
}

function message(text: string): TestAssistantMessage {
  return { stopReason: "stop", content: [{ type: "text", text }] };
}

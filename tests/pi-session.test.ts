import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryPiPreferenceRepository,
  createPiExtension,
  PermissionJudgeSession,
} from "../src/index.ts";
import type {
  PiExtension,
  PiExtensionCommand,
  PiExtensionContext,
  PiModel,
} from "../src/index.ts";

const authorization = {
  authorized: true,
  defaultModel: { provider: "fictional-provider", id: "model-a" },
  timeoutMs: 15_000,
} as const;

const models: readonly PiModel[] = [
  { provider: "fictional-provider", id: "model-a" },
  { provider: "fictional-provider", id: "model-b" },
  { provider: "cloudflare", id: "@cf/moonshotai/kimi-k2.6" },
];

test("Pi permission judge preferences persist globally while session snapshots stay stable", async () => {
  const command = registerJudgeCommand(createPiExtension({ permissionJudge: authorization }));
  const sessionA = {};
  const sessionB = {};
  const notificationsA: string[] = [];
  const notificationsB: string[] = [];
  const contextA = context("/project", sessionA, notificationsA);
  const contextB = context("/project", sessionB, notificationsB);

  await command.handler("status", contextA);
  assert.match(notificationsA.at(-1) ?? "", /off.*fictional-provider\/model-a/iu);

  await command.handler("on", contextA);
  assert.match(notificationsA.at(-1) ?? "", /enabled.*fictional-provider\/model-a/iu);

  await command.handler("status", contextB);
  assert.match(notificationsB.at(-1) ?? "", /enabled.*fictional-provider\/model-a/iu);

  await command.handler("model fictional-provider model-b", contextA);
  assert.match(notificationsA.at(-1) ?? "", /model.*fictional-provider\/model-b/iu);
  await command.handler("status", contextA);
  assert.match(notificationsA.at(-1) ?? "", /enabled.*fictional-provider\/model-b/iu);

  await command.handler("model cloudflare @cf/moonshotai/kimi-k2.6", contextA);
  assert.match(notificationsA.at(-1) ?? "", /cloudflare\/@cf\/moonshotai\/kimi-k2\.6/iu);

  await command.handler("model fictional-provider model-b", contextA);
  await command.handler("model fictional-provider missing", contextA);
  assert.match(notificationsA.at(-1) ?? "", /not available/iu);
  await command.handler("status", contextA);
  assert.match(notificationsA.at(-1) ?? "", /fictional-provider\/model-b/iu);

  const notificationsC: string[] = [];
  await command.handler("status", context("/project", {}, notificationsC));
  assert.match(notificationsC.at(-1) ?? "", /fictional-provider\/model-b/iu);

  await command.handler("reset", contextA);
  assert.match(notificationsA.at(-1) ?? "", /preferences reset/iu);
  await command.handler("off", contextA);
  assert.match(notificationsA.at(-1) ?? "", /off/iu);
});

test("Pi permission judge controls fail closed for unavailable models and project disable", async () => {
  const extension = createPiExtension((context) => ({
    permissionJudge: context.cwd === "/enabled" ? authorization : { authorized: false },
  }));
  const command = registerJudgeCommand(extension);
  const disabledNotifications: string[] = [];
  const unavailableNotifications: string[] = [];

  const disabledContext = context("/disabled", {}, disabledNotifications);
  await command.handler("on", disabledContext);
  assert.match(disabledNotifications.at(-1) ?? "", /not authorized/iu);
  await command.handler("model fictional-provider model-a", disabledContext);
  assert.match(disabledNotifications.at(-1) ?? "", /model set/iu);
  await command.handler("status", disabledContext);
  assert.match(disabledNotifications.at(-1) ?? "", /not authorized/iu);

  await command.handler(
    "on",
    context("/enabled", {}, unavailableNotifications, []),
  );
  assert.match(unavailableNotifications.at(-1) ?? "", /not available/iu);
});

test("Pi session status preserves a project disable separately from global authorization", async () => {
  const extension = createPiExtension({
    permissionJudge: { authorized: false },
    permissionJudgeSessionPolicy: {
      globalAuthorization: authorization,
      projectDisabled: true,
    },
  });
  const command = registerJudgeCommand(extension);
  const notifications: string[] = [];
  const commandContext = context("/disabled-project", {}, notifications);

  await command.handler("on", commandContext);
  assert.match(notifications.at(-1) ?? "", /disabled by project policy/iu);
});

test("Pi model scope is enforced without changing the primary model", async () => {
  const command = registerJudgeCommand(createPiExtension({ permissionJudge: authorization }));
  const notifications: string[] = [];
  const primaryModel = { provider: "fictional-provider", id: "primary-model" };
  const scopedContext = context("/project", {}, notifications, models, [models[0]]);
  Object.assign(scopedContext, { model: primaryModel });

  await command.handler("model fictional-provider model-b", scopedContext);
  assert.match(notifications.at(-1) ?? "", /not available/iu);
  await command.handler("on", scopedContext);
  assert.match(notifications.at(-1) ?? "", /enabled.*fictional-provider\/model-a/iu);
  assert.deepEqual(scopedContext.model, primaryModel);
});

test("Pi reset clears persisted model and thinking while preserving Auto and shortcuts", async () => {
  const repository = createMemoryPiPreferenceRepository({
    version: 1,
    autoEnabled: true,
    model: { provider: "fictional-provider", id: "model-b" },
    thinking: "off",
    shortcuts: { menu: "alt+g", toggleAuto: "alt+a" },
  });
  const command = registerJudgeCommand(
    createPiExtension({ permissionJudge: authorization }, repository),
  );
  const notifications: string[] = [];
  await command.handler("reset", context("/project", {}, notifications));

  assert.deepEqual(repository.load().preferences, {
    version: 1,
    autoEnabled: true,
    shortcuts: { menu: "alt+g", toggleAuto: "alt+a" },
  });
  const restored: string[] = [];
  await command.handler("status", context("/project", {}, restored));
  assert.match(restored.at(-1) ?? "", /enabled.*model-a.*inherit/iu);
});

test("empty judge command opens TUI controls but not RPC dialogs", async () => {
  const repository = createMemoryPiPreferenceRepository();
  const command = registerJudgeCommand(
    createPiExtension({ permissionJudge: authorization }, repository),
  );
  let hubOpens = 0;
  const tuiContext = context("/project", {}, []);
  Object.assign(tuiContext, {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      async input() { return "model-b"; },
      async select(title: string, options: readonly string[]) {
        if (title === "Auto Mode Gate") {
          hubOpens += 1;
          return hubOpens === 1
            ? options.find((option) => option.startsWith("Judge model:"))
            : undefined;
        }
        if (title === "Judge model") return options[0];
        return undefined;
      },
    },
  });
  await command.handler("", tuiContext);
  assert.equal(hubOpens, 2);
  assert.deepEqual(repository.load().preferences.model, {
    provider: "fictional-provider",
    id: "model-b",
  });

  let rpcDialogs = 0;
  const rpcNotifications: string[] = [];
  const rpcContext = context("/project", {}, rpcNotifications);
  Object.assign(rpcContext, {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify(message: string) { rpcNotifications.push(message); },
      async input() { rpcDialogs += 1; return undefined; },
      async select() { rpcDialogs += 1; return undefined; },
    },
  });
  await command.handler("", rpcContext);
  assert.equal(rpcDialogs, 0);
  assert.match(rpcNotifications.at(-1) ?? "", /off|enabled/iu);
});

test("Pi permission judge command handles usage and UI failures safely", async () => {
  const command = registerJudgeCommand(createPiExtension({ permissionJudge: authorization }));
  const notifications: string[] = [];
  const commandContext = context("/project", {}, notifications);

  await command.handler("", commandContext);
  assert.match(notifications.at(-1) ?? "", /off/iu);
  await command.handler("unknown", commandContext);
  assert.match(notifications.at(-1) ?? "", /Usage:/u);
  await command.handler("model fictional-provider", commandContext);
  assert.match(notifications.at(-1) ?? "", /Usage:/u);

  const brokenUi = {
    ...context("/project", {}, []),
    ui: { notify() { throw new Error("fictional UI failure"); } },
  };
  await assert.doesNotReject(command.handler("status", brokenUi));

  const rejectedUi = {
    ...context("/project", {}, []),
    ui: { async notify() { throw new Error("fictional async UI failure"); } },
  };
  await assert.doesNotReject(command.handler("status", rejectedUi));
  await Promise.resolve();
});

test("permission judge authorization snapshots the timeout once", () => {
  let timeoutReads = 0;
  const hostileAuthorization = new Proxy(
    {
      authorized: true as const,
      defaultModel: { provider: "fictional-provider", id: "model-a" },
      timeoutMs: 1_000,
    },
    {
      get(target, property, receiver) {
        if (property === "timeoutMs") {
          timeoutReads += 1;
          return timeoutReads === 1 ? 1_000 : 999_999_999;
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const session = new PermissionJudgeSession(hostileAuthorization);
  assert.equal(session.timeoutMs(), 1_000);
  assert.equal(timeoutReads, 1);
});

test("requested Auto survives project, scope, model, and thinking restrictions", () => {
  const preferences = {
    version: 1,
    autoEnabled: true,
    model: { provider: "fictional-provider", id: "model-b" },
    thinking: "high",
    shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
  } as const;
  const projectDisabled = new PermissionJudgeSession({
    globalAuthorization: authorization,
    projectDisabled: true,
  }, preferences);
  const available = {
    scopeAvailable: true,
    isModelAvailable: () => true,
    supportedThinking: () => ["inherit", "off", "low", "high"] as const,
  };
  const disabledStatus = projectDisabled.status(available);
  assert.equal(disabledStatus.autoRequested, true);
  assert.equal(disabledStatus.autoEffective, false);
  assert.equal(disabledStatus.reason, "project-disabled");

  const missingScope = new PermissionJudgeSession(authorization, preferences);
  const missingScopeStatus = missingScope.status({ ...available, scopeAvailable: false });
  assert.equal(missingScopeStatus.autoRequested, true);
  assert.equal(missingScopeStatus.reason, "scope-unavailable");
  assert.deepEqual(missingScope.preferences(), preferences);

  const unsupported = missingScope.status({
    ...available,
    supportedThinking: () => ["inherit", "off", "low"] as const,
  });
  assert.equal(unsupported.reason, "thinking-unsupported");
  assert.equal(unsupported.thinkingRequested, "high");
  assert.deepEqual(missingScope.preferences(), preferences);
});

test("session previews do not mutate state before persistence commits", () => {
  const session = new PermissionJudgeSession(authorization, {
    version: 1,
    autoEnabled: false,
    shortcuts: { menu: "ctrl+alt+g", toggleAuto: "ctrl+alt+a" },
  });
  const available = {
    scopeAvailable: true,
    isModelAvailable: () => true,
    supportedThinking: () => ["inherit", "off", "high"] as const,
  };

  const preview = session.preview({ type: "auto", enabled: true }, available);
  assert.equal(preview.accepted, true);
  assert.equal(session.status(available).autoRequested, false);
  if (preview.accepted) session.commit(preview.preferences);
  assert.equal(session.status(available).autoRequested, true);
});

test("a new Pi extension instance resets session state", async () => {
  const sessionManager = {};
  const firstNotifications: string[] = [];
  const first = registerJudgeCommand(createPiExtension({ permissionJudge: authorization }));
  await first.handler("on", context("/project", sessionManager, firstNotifications));
  assert.match(firstNotifications.at(-1) ?? "", /enabled/iu);

  const secondNotifications: string[] = [];
  const second = registerJudgeCommand(createPiExtension({ permissionJudge: authorization }));
  await second.handler("status", context("/project", sessionManager, secondNotifications));
  assert.match(secondNotifications.at(-1) ?? "", /off/iu);
});

function registerJudgeCommand(extension: PiExtension): PiExtensionCommand {
  let command: PiExtensionCommand | undefined;
  extension({
    on() {},
    registerCommand(name, registered) {
      assert.equal(name, "amg-judge");
      command = registered;
    },
  });
  assert.ok(command);
  return command;
}

function context(
  cwd: string,
  sessionManager: object,
  notifications: string[],
  availableModels: readonly PiModel[] = models,
  scopedModels: readonly PiModel[] = [],
): PiExtensionContext {
  return {
    cwd,
    sessionManager,
    modelRegistry: {
      getAvailable: () => availableModels,
      find: (provider, id) => availableModels.find(
        (model) => model.provider === provider && model.id === id,
      ),
    },
    scopedModels: scopedModels.map((model) => ({ model })),
    ui: {
      notify(message) {
        notifications.push(message);
      },
    },
  };
}

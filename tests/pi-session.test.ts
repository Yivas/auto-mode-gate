import assert from "node:assert/strict";
import test from "node:test";

import { createPiExtension } from "../src/index.ts";
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

test("Pi permission judge controls are isolated by session and start disabled", async () => {
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
  assert.match(notificationsB.at(-1) ?? "", /off.*fictional-provider\/model-a/iu);

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

  await command.handler("reset", contextA);
  assert.match(notificationsA.at(-1) ?? "", /fictional-provider\/model-a/iu);
  await command.handler("off", contextA);
  assert.match(notificationsA.at(-1) ?? "", /disabled/iu);
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
  assert.match(disabledNotifications.at(-1) ?? "", /not authorized/iu);

  await command.handler(
    "on",
    context("/enabled", {}, unavailableNotifications, []),
  );
  assert.match(unavailableNotifications.at(-1) ?? "", /not available/iu);
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

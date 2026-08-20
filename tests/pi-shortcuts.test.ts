import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryPiPreferenceRepository,
  createPiExtension,
  DEFAULT_PI_JUDGE_SHORTCUTS,
} from "../src/index.ts";
import type {
  PiExtensionContext,
  PiExtensionShortcut,
  PiModel,
} from "../src/index.ts";

const authorization = {
  authorized: true,
  defaultModel: { provider: "fictional-provider", id: "judge-model" },
  timeoutMs: 15_000,
} as const;
const model: PiModel = {
  provider: "fictional-provider",
  id: "judge-model",
  reasoning: true,
};

test("AMG9 default shortcuts avoid Pi v0.84.2 documented bindings", () => {
  const reserved = new Set([
    "ctrl+c",
    "ctrl+d",
    "ctrl+g",
    "ctrl+l",
    "ctrl+o",
    "ctrl+p",
    "ctrl+r",
    "ctrl+s",
    "ctrl+t",
    "ctrl+x",
    "ctrl+shift+f",
    "ctrl+shift+g",
    "ctrl+shift+p",
    "shift+tab",
  ]);
  assert.equal(reserved.has(DEFAULT_PI_JUDGE_SHORTCUTS.menu), false);
  assert.equal(reserved.has(DEFAULT_PI_JUDGE_SHORTCUTS.toggleAuto), false);
  assert.notEqual(
    DEFAULT_PI_JUDGE_SHORTCUTS.menu,
    DEFAULT_PI_JUDGE_SHORTCUTS.toggleAuto,
  );
});

test("custom shortcut preferences apply only when the extension reloads", () => {
  const repository = createMemoryPiPreferenceRepository({
    version: 1,
    autoEnabled: false,
    shortcuts: { menu: "alt+g", toggleAuto: "alt+a" },
  });
  const shortcuts = new Map<string, PiExtensionShortcut>();
  createPiExtension({ permissionJudge: authorization }, repository)({
    on() {},
    registerShortcut(shortcut, definition) {
      shortcuts.set(shortcut, definition);
    },
  });
  assert.deepEqual([...shortcuts.keys()].sort(), ["alt+a", "alt+g"]);
});

test("the Auto shortcut persists before updating status and applies after reload", async () => {
  const repository = createMemoryPiPreferenceRepository();
  const shortcuts = new Map<string, PiExtensionShortcut>();
  const extension = createPiExtension({ permissionJudge: authorization }, repository);
  extension({
    on() {},
    registerShortcut(shortcut, definition) {
      shortcuts.set(shortcut, definition);
    },
  });
  assert.deepEqual([...shortcuts.keys()].sort(), ["ctrl+alt+a", "ctrl+alt+g"]);

  const statuses: string[] = [];
  const context = piContext({}, statuses);
  await shortcuts.get("ctrl+alt+a")?.handler(context);
  assert.equal(repository.load().preferences.autoEnabled, true);
  assert.equal(statuses.at(-1), "AMG:on→on");

  const reloaded = createPiExtension({ permissionJudge: authorization }, repository);
  let commandStatus = "";
  reloaded({
    on() {},
    registerCommand(_name, command) {
      void command.handler("status", piContext({}, [], (message) => {
        commandStatus = message;
      }));
    },
  });
  await Promise.resolve();
  assert.match(commandStatus, /enabled/iu);
});

test("a persistence failure leaves the shortcut state unchanged", async () => {
  const repository = {
    load: () => ({
      preferences: {
        version: 1 as const,
        autoEnabled: false,
        shortcuts: DEFAULT_PI_JUDGE_SHORTCUTS,
      },
    }),
    save() {
      throw new Error("fictional disk failure");
    },
  };
  const shortcuts = new Map<string, PiExtensionShortcut>();
  createPiExtension({ permissionJudge: authorization }, repository)({
    on() {},
    registerShortcut(shortcut, definition) {
      shortcuts.set(shortcut, definition);
    },
  });
  const notifications: string[] = [];
  const statuses: string[] = [];
  await shortcuts.get("ctrl+alt+a")?.handler(
    piContext({}, statuses, (message) => notifications.push(message)),
  );
  assert.equal(notifications.some((message) => /could not save/iu.test(message)), true);
  assert.equal(statuses.length, 0);
  assert.equal(repository.load().preferences.autoEnabled, false);
});

function piContext(
  sessionManager: object,
  statuses: string[],
  onNotify: (message: string) => void = () => {},
): PiExtensionContext {
  return {
    cwd: "/project",
    sessionManager,
    modelRegistry: {
      getAvailable: () => [model],
      find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    },
    scopedModels: [],
    ui: {
      notify: onNotify,
      setStatus(_key, text) {
        if (text) statuses.push(text);
      },
    },
  };
}

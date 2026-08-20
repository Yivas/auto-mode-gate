import assert from "node:assert/strict";
import test from "node:test";

import {
  canOpenPiJudgeMenu,
  filterPiMenuModels,
  formatPiJudgeFooter,
  openPiJudgeMenu,
  type PiMenuOperations,
} from "../src/pi-menu.ts";
import type { PermissionJudgeSessionStatus } from "../src/types.ts";

const model = { provider: "fictional-provider", id: "model-a" } as const;

function status(overrides: Partial<PermissionJudgeSessionStatus> = {}): PermissionJudgeSessionStatus {
  return {
    authorized: true,
    available: true,
    enabled: false,
    model,
    globalAuthorization: "authorized",
    projectRestriction: "none",
    autoRequested: false,
    autoEffective: false,
    effectiveModel: model,
    modelAvailable: true,
    thinkingRequested: "inherit",
    thinkingEffective: "inherit",
    ...overrides,
  };
}

test("the Pi judge menu opens only in TUI mode with native dialogs", () => {
  const ui = { async select() { return undefined; }, async input() { return undefined; } };
  assert.equal(canOpenPiJudgeMenu({ mode: "tui", hasUI: true, ui }), true);
  assert.equal(canOpenPiJudgeMenu({ mode: "rpc", hasUI: true, ui }), false);
  assert.equal(canOpenPiJudgeMenu({ mode: "print", hasUI: false, ui }), false);
  assert.equal(canOpenPiJudgeMenu({ mode: "tui", hasUI: true, ui: {} }), false);
});

test("the Pi judge menu shares Auto transitions and treats cancel as a no-op", async () => {
  const selections = ["Auto: off", undefined];
  const actions: string[] = [];
  const operations: PiMenuOperations = {
    status: () => status(),
    models: () => [model],
    thinking: () => ["inherit", "off"],
    async setAuto(enabled) { actions.push(`auto:${enabled}`); },
    async setModel() { actions.push("model"); },
    async setThinking() { actions.push("thinking"); },
    async reset() { actions.push("reset"); },
  };

  await openPiJudgeMenu({
    mode: "tui",
    hasUI: true,
    ui: {
      async select() { return selections.shift(); },
      async input() { return undefined; },
    },
  }, operations);

  assert.deepEqual(actions, ["auto:true"]);
});

test("model search keeps full values while filtering provider, id, and name", () => {
  const longId = `model-${"x".repeat(180)}`;
  const models = [
    { provider: "alpha", id: longId, name: "Long model" },
    { provider: "beta", id: "short", name: "Compact" },
    { provider: "alpha", id: longId, name: "Duplicate" },
  ];

  assert.deepEqual(filterPiMenuModels(models, "compact"), [models[1]]);
  assert.deepEqual(filterPiMenuModels(models, "alpha/model"), [models[0]]);
  assert.equal(filterPiMenuModels(models, "")[0]?.id.length, longId.length);
  assert.equal(filterPiMenuModels(models, "").length, 2);
});

test("footer status is compact and distinguishes requested and effective Auto", () => {
  assert.equal(formatPiJudgeFooter(status()), "AMG:off");
  assert.equal(formatPiJudgeFooter(status({
    autoRequested: true,
    autoEffective: true,
    enabled: true,
  })), "AMG:on→on");
  assert.equal(formatPiJudgeFooter(status({
    autoRequested: true,
    autoEffective: false,
    reason: "model-unavailable",
    available: false,
    modelAvailable: false,
    effectiveModel: undefined,
    thinkingEffective: undefined,
  })), "AMG:on→unavailable");
});

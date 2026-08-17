import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AutoModeGate, RejectionTracker } from "../src/index.ts";
import type {
  GateConfig,
  PermissionJudge,
  PermissionJudgeOutcome,
  PermissionJudgeRequest,
} from "../src/index.ts";

interface JudgeFixture {
  readonly name: string;
  readonly config: GateConfig;
  readonly input: unknown;
  readonly outcome: PermissionJudgeOutcome | null;
  readonly expected: {
    readonly policyVerdict: string;
    readonly effect: string;
    readonly code: string;
    readonly source: string;
    readonly blocked: boolean;
    readonly calls: number;
  };
}

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/judge-conformance.json", import.meta.url), "utf8"),
) as JudgeFixture[];

for (const fixture of fixtures) {
  test(`judge core conformance: ${fixture.name}`, async () => {
    let calls = 0;
    const judge: PermissionJudge | undefined = fixture.outcome
      ? {
          async evaluate(_request, _signal) {
            calls += 1;
            return fixture.outcome;
          },
        }
      : undefined;
    const decision = await new AutoModeGate(fixture.config).evaluateWithJudge(
      fixture.input,
      judge,
    );

    assert.deepEqual(
      {
        policyVerdict: decision.policyVerdict,
        effect: decision.effect,
        code: decision.code,
        source: decision.source,
        blocked: decision.blocked,
        calls,
      },
      fixture.expected,
    );
    const serializedLog = JSON.stringify({
      ...decision.log,
      repeatedRejectionCount: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(Buffer.byteLength(serializedLog, "utf8") <= 512);
    assert.equal(serializedLog.includes("amg-permission-judge/v1"), false);
    assert.equal(serializedLog.includes("/trusted/bin"), false);
    assert.equal(serializedLog.includes("./src"), false);
  });
}

test("eligible synchronous evaluation degrades to unavailable", () => {
  const decision = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  }).evaluate(eligibleInput());

  assert.equal(decision.code, "AMG_DENY_JUDGE_UNAVAILABLE");
  assert.equal(decision.source, "judge");
  assert.equal(decision.blocked, true);
});

test("judge exceptions and malformed outcomes fail closed", async () => {
  const gate = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  });
  const thrown = await gate.evaluateWithJudge(eligibleInput(), {
    async evaluate() {
      throw new Error("fictional-sensitive-transport-error");
    },
  });
  const malformed = await gate.evaluateWithJudge(eligibleInput(), {
    async evaluate() {
      return { status: "response", response: { verdict: "allow" } };
    },
  });
  const unreadable = await gate.evaluateWithJudge(eligibleInput(), {
    async evaluate() {
      return new Proxy({}, { get: () => { throw new Error("unreadable outcome"); } });
    },
  });

  assert.equal(thrown.code, "AMG_DENY_JUDGE_ERROR");
  assert.equal(JSON.stringify(thrown).includes("fictional-sensitive-transport-error"), false);
  assert.equal(malformed.code, "AMG_DENY_JUDGE_INVALID_RESPONSE");
  assert.equal(unreadable.code, "AMG_DENY_JUDGE_ERROR");
});

test("pre-cancelled evaluation skips the judge and finalizes once", async () => {
  class CountingTracker extends RejectionTracker {
    calls = 0;

    override record(equivalenceInput: string, code: Parameters<RejectionTracker["record"]>[1]) {
      this.calls += 1;
      return super.record(equivalenceInput, code);
    }
  }

  const controller = new AbortController();
  controller.abort();
  const tracker = new CountingTracker();
  let judgeCalls = 0;
  const decision = await new AutoModeGate(
    { mode: "enforce", trustedExecutablePaths: ["/trusted/bin/git"] },
    tracker,
  ).evaluateWithJudge(
    eligibleInput(),
    {
      async evaluate(_request: PermissionJudgeRequest) {
        judgeCalls += 1;
        return { status: "response", response: {
          protocol: "amg-permission-judge/v1",
          verdict: "allow",
        } } as const;
      },
    },
    controller.signal,
  );

  assert.equal(decision.code, "AMG_DENY_JUDGE_CANCELLED");
  assert.equal(judgeCalls, 0);
  assert.equal(tracker.calls, 1);
});

test("in-flight cancellation cannot be overridden by judge allow", async () => {
  const controller = new AbortController();
  const decision = await new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  }).evaluateWithJudge(
    eligibleInput(),
    {
      async evaluate() {
        controller.abort();
        return {
          status: "response",
          response: { protocol: "amg-permission-judge/v1", verdict: "allow" },
        } as const;
      },
    },
    controller.signal,
  );

  assert.equal(decision.code, "AMG_DENY_JUDGE_CANCELLED");
  assert.equal(decision.effect, "deny");
  assert.equal(decision.blocked, true);
});

test("cancellation finalizes when a custom judge ignores AbortSignal", async () => {
  const controller = new AbortController();
  const pending = new Promise<never>(() => {});
  const evaluation = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  }).evaluateWithJudge(
    eligibleInput(),
    { async evaluate() { return pending; } },
    controller.signal,
  );

  controller.abort();
  const decision = await evaluation;
  assert.equal(decision.code, "AMG_DENY_JUDGE_CANCELLED");
  assert.equal(decision.effect, "deny");
});

test("cancellation during outcome validation cannot be overridden", async () => {
  const controller = new AbortController();
  const outcome = new Proxy(
    {
      status: "response",
      response: { protocol: "amg-permission-judge/v1", verdict: "allow" },
    },
    {
      get(target, property, receiver) {
        if (property === "status") {
          controller.abort();
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const decision = await new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  }).evaluateWithJudge(
    eligibleInput(),
    { async evaluate() { return outcome; } },
    controller.signal,
  );

  assert.equal(decision.code, "AMG_DENY_JUDGE_CANCELLED");
  assert.equal(decision.effect, "deny");
});

function eligibleInput() {
  return {
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "/trusted/bin/git diff --stat ./src",
    executable: { name: "git", path: "/trusted/bin/git", source: "trusted-path" },
    host: "pi",
  } as const;
}

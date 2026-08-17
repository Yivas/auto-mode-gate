import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AutoModeGate, RejectionTracker, mergeConfig } from "../src/index.ts";
import type {
  GateConfig,
  PermissionAssessment,
  PermissionJudgeDecisionCode,
  PermissionJudgeDecisionSource,
} from "../src/index.ts";

interface Fixture {
  readonly name: string;
  readonly config?: GateConfig;
  readonly input: unknown;
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

for (const fixture of fixtures) {
  test(`conformance: ${fixture.name}`, () => {
    const decision = new AutoModeGate(fixture.config).evaluate(fixture.input);
    assert.deepEqual(
      {
        policyVerdict: decision.policyVerdict,
        effect: decision.effect,
        code: decision.code,
        blocked: decision.blocked,
      },
      fixture.expected,
    );
  });
}

test("dangerous rules take precedence over unsupported compound syntax", () => {
  const gate = new AutoModeGate();
  const compound = gate.evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "rm -rf build | cat",
  });
  const executableDiff = gate.evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "git diff --ext-diff",
  });

  assert.equal(compound.code, "AMG_DENY_DANGEROUS_COMMAND");
  assert.equal(executableDiff.code, "AMG_DENY_DANGEROUS_COMMAND");
});

test("ambiguous decisions become structured denials", () => {
  const decision = new AutoModeGate().evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "unknown-command",
  });

  assert.equal(decision.policyVerdict, "ambiguous");
  assert.equal(decision.effect, "deny");
  assert.deepEqual(decision.denial, {
    code: "AMG_DENY_AMBIGUOUS",
    message: "The command could not be classified as safe.",
  });
});

test("the judge contract keeps current decision results unchanged", () => {
  const contract = [
    { state: "allow-final", policyVerdict: "allow" },
    { state: "deny-final", policyVerdict: "deny" },
    {
      state: "unresolved-ineligible",
      policyVerdict: "ambiguous",
      eligibility: { state: "ineligible" },
    },
    {
      state: "unresolved-eligible",
      policyVerdict: "ambiguous",
      eligibility: {
        state: "eligible",
        request: { protocol: "amg-permission-judge/v1" },
      },
    },
  ] satisfies readonly PermissionAssessment[];
  const judgeCodes = [
    "AMG_ALLOW_JUDGE",
    "AMG_DENY_JUDGE",
    "AMG_DENY_JUDGE_UNAVAILABLE",
    "AMG_DENY_JUDGE_TIMEOUT",
    "AMG_DENY_JUDGE_CANCELLED",
    "AMG_DENY_JUDGE_INVALID_RESPONSE",
    "AMG_DENY_JUDGE_ERROR",
  ] satisfies readonly PermissionJudgeDecisionCode[];
  const judgeSource = "judge" satisfies PermissionJudgeDecisionSource;

  assert.deepEqual(contract.map((assessment) => assessment.state), [
    "allow-final",
    "deny-final",
    "unresolved-ineligible",
    "unresolved-eligible",
  ]);
  assert.equal(judgeCodes.length, 7);
  assert.equal(judgeSource, "judge");

  const decision = new AutoModeGate().evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "custom-tool inspect",
  });
  assert.deepEqual(
    {
      policyVerdict: decision.policyVerdict,
      effect: decision.effect,
      code: decision.code,
      source: decision.source,
      blocked: decision.blocked,
    },
    {
      policyVerdict: "ambiguous",
      effect: "deny",
      code: "AMG_DENY_AMBIGUOUS",
      source: "deterministic",
      blocked: true,
    },
  );
  assert.equal("assessmentState" in decision, false);
});

test("finalization records each rejection once", () => {
  class CountingTracker extends RejectionTracker {
    calls = 0;

    override record(equivalenceInput: string, code: Parameters<RejectionTracker["record"]>[1]) {
      this.calls += 1;
      return super.record(equivalenceInput, code);
    }
  }

  const tracker = new CountingTracker();
  const gate = new AutoModeGate({ mode: "enforce" }, tracker);

  gate.evaluate({ kind: "shell", tool: "shell", shell: "bash", command: "rm file" });
  gate.evaluate({ kind: "shell", tool: "shell", shell: "bash", command: "custom-tool inspect" });
  gate.evaluate({ kind: "shell", tool: "shell", shell: "bash", command: "" });

  const unreadable = new Proxy({}, { get: () => { throw new Error("unreadable input"); } });
  const internalError = gate.evaluate(unreadable);

  assert.equal(tracker.calls, 3);
  assert.equal(internalError.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(internalError.repeatedRejectionCount, 0);
});

test("every denial code has a stable structured message", () => {
  const cases = [
    {
      input: { kind: "shell", tool: "shell", shell: "bash", command: "rm file" },
      code: "AMG_DENY_DANGEROUS_COMMAND",
      message: "The command matches a deterministic deny rule.",
    },
    {
      input: { kind: "unknown" },
      code: "AMG_DENY_UNKNOWN_ACTION",
      message: "The action type or shell is not supported.",
    },
    {
      input: { kind: "shell", tool: "shell", shell: "bash", command: "" },
      code: "AMG_DENY_INVALID_INPUT",
      message: "The action input is missing, truncated, or invalid.",
    },
  ] as const;

  for (const fixture of cases) {
    const decision = new AutoModeGate().evaluate(fixture.input);
    assert.equal(decision.code, fixture.code);
    assert.deepEqual(decision.denial, { code: fixture.code, message: fixture.message });
  }
});

test("shadow and off modes never report a blocked action", () => {
  const input = { kind: "shell", tool: "shell", shell: "bash", command: "rm file" };

  for (const mode of ["shadow", "off"] as const) {
    const decision = new AutoModeGate({ mode }).evaluate(input);
    assert.equal(decision.effect, "deny");
    assert.equal(decision.blocked, false);
    assert.equal(decision.log.mode, mode);
  }
});

test("project configuration can tighten but not relax global policy", () => {
  assert.deepEqual(mergeConfig({ mode: "off" }, { mode: "enforce" }), {
    mode: "off",
    trustedExecutablePaths: [],
  });
  assert.deepEqual(mergeConfig({ mode: "shadow" }, { mode: "enforce" }), {
    mode: "enforce",
    trustedExecutablePaths: [],
  });
  assert.deepEqual(mergeConfig({ mode: "enforce" }, { mode: "off" }), {
    mode: "enforce",
    trustedExecutablePaths: [],
  });
  assert.deepEqual(
    mergeConfig(
      { mode: "enforce", trustedExecutablePaths: ["/trusted/a", "/trusted/b"] },
      { trustedExecutablePaths: ["/trusted/b", "/untrusted/c"] },
    ),
    { mode: "enforce", trustedExecutablePaths: ["/trusted/b"] },
  );
});

test("invalid configuration fails closed", () => {
  const throwingConfig = new Proxy(
    {},
    {
      get() {
        throw new Error("unreadable config");
      },
    },
  );
  const decision = new AutoModeGate({ mode: "invalid" as never }).evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "rm file",
  });

  assert.equal(decision.mode, "enforce");
  assert.equal(decision.blocked, true);
  assert.equal(new AutoModeGate(throwingConfig as never).evaluate({}).blocked, true);
  assert.deepEqual(mergeConfig({ mode: "shadow" }, { mode: "invalid" as never }), {
    mode: "enforce",
    trustedExecutablePaths: [],
  });
});

test("internal evaluation errors fail closed without exposing input", () => {
  const input = new Proxy(
    {},
    {
      get() {
        throw new Error("fictional-sensitive-error");
      },
    },
  );
  const decision = new AutoModeGate().evaluate(input);

  assert.equal(decision.code, "AMG_DENY_INTERNAL_ERROR");
  assert.equal(decision.blocked, true);
  assert.deepEqual(decision.denial, {
    code: "AMG_DENY_INTERNAL_ERROR",
    message: "The action could not be evaluated safely.",
  });
  assert.equal(JSON.stringify(decision).includes("fictional-sensitive-error"), false);
});

test("input fields are read once before classification", () => {
  let commandReads = 0;
  const input = {
    kind: "shell",
    tool: "shell",
    shell: "bash",
    executable: { name: "ls", path: "/trusted/bin/ls", source: "trusted-path" },
    get command() {
      commandReads += 1;
      return commandReads === 1 ? "/trusted/bin/ls" : "rm -rf build";
    },
  };
  const decision = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/ls"],
  }).evaluate(input);

  assert.equal(decision.code, "AMG_ALLOW_SAFE_COMMAND");
  assert.equal(commandReads, 1);
});

test("safe names require configured matching absolute executable identity", () => {
  const gate = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/ls", "/trusted/bin/printf"],
  });
  const base = {
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "/trusted/bin/ls",
  };

  assert.equal(gate.evaluate(base).code, "AMG_DENY_AMBIGUOUS");
  assert.equal(
    gate.evaluate({
      ...base,
      executable: { name: "ls", path: "/trusted/bin/ls", source: "trusted-path" },
    }).code,
    "AMG_ALLOW_SAFE_COMMAND",
  );
  assert.equal(
    gate.evaluate({
      ...base,
      executable: { name: "cat", path: "/trusted/bin/ls", source: "trusted-path" },
    }).code,
    "AMG_DENY_AMBIGUOUS",
  );
  assert.equal(
    gate.evaluate({
      ...base,
      command: "ls",
      executable: { name: "ls", path: "/trusted/bin/ls", source: "trusted-path" },
    }).code,
    "AMG_DENY_AMBIGUOUS",
  );
  assert.equal(
    gate.evaluate({
      ...base,
      command: "/tmp/ls",
      executable: { name: "ls", path: "/tmp/ls", source: "trusted-path" },
    }).code,
    "AMG_DENY_AMBIGUOUS",
  );
  assert.equal(
    gate.evaluate({
      ...base,
      executable: { name: "ls", path: "/trusted/bin/ls", source: "shell-builtin" },
    }).code,
    "AMG_DENY_INVALID_INPUT",
  );
  assert.equal(
    gate.evaluate({
      ...base,
      command: "/trusted/bin/printf -v AMG_VAR value",
      executable: {
        name: "printf",
        path: "/trusted/bin/printf",
        source: "trusted-path",
      },
    }).code,
    "AMG_DENY_AMBIGUOUS",
  );
});

test("decisions, denials, and logs are immutable at runtime", () => {
  const decision = new AutoModeGate().evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: "rm file",
  });

  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.denial), true);
  assert.equal(Object.isFrozen(decision.log), true);
});

test("equivalent rejections are counted only in memory", () => {
  const gate = new AutoModeGate();
  const input = { kind: "shell", tool: "shell", shell: "cmd", command: "del file.txt" };

  assert.equal(gate.evaluate(input).repeatedRejectionCount, 1);
  assert.equal(gate.evaluate(input).repeatedRejectionCount, 2);
  assert.equal(
    gate.evaluate({ ...input, command: "del other.txt" }).repeatedRejectionCount,
    1,
  );
});

test("rejection tracking has a fixed memory ceiling", () => {
  const gate = new AutoModeGate();
  const input = { kind: "shell", tool: "shell", shell: "cmd", command: "del file-0" };

  gate.evaluate(input);
  for (let index = 1; index <= 1_024; index += 1) {
    gate.evaluate({ ...input, command: `del file-${index}` });
  }

  assert.equal(gate.evaluate(input).repeatedRejectionCount, 1);
});

test("logs exclude sensitive input and stay within the size limit", () => {
  const secret = "fictional-secret-value";
  const decision = new AutoModeGate().evaluate({
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command: `cat ${secret}`,
    host: "pi",
    context: { sessionId: "fictional-session" },
  });
  const serializedLog = JSON.stringify(decision.log);

  assert.equal(serializedLog.includes(secret), false);
  assert.equal(serializedLog.includes("fictional-session"), false);
  assert.deepEqual(Object.keys(decision.log).sort(), [
    "blocked",
    "code",
    "effect",
    "host",
    "mode",
    "policyVerdict",
    "repeatedRejectionCount",
    "shell",
    "source",
    "tool",
  ]);

  for (const fixture of fixtures) {
    for (const mode of ["off", "shadow", "enforce"] as const) {
      for (const host of ["unknown", "opencode", "pi"] as const) {
        const input =
          typeof fixture.input === "object" && fixture.input !== null && !Array.isArray(fixture.input)
            ? { ...fixture.input, host }
            : fixture.input;
        const log = new AutoModeGate({ ...fixture.config, mode }).evaluate(input).log;
        const largestCountLog = { ...log, repeatedRejectionCount: Number.MAX_SAFE_INTEGER };
        assert.ok(Buffer.byteLength(JSON.stringify(largestCountLog), "utf8") <= 512);
      }
    }
  }
});

test("malformed values and oversized input fail closed", () => {
  const malformed: unknown[] = [
    null,
    [],
    "ls",
    {},
    { kind: "shell", tool: "shell", shell: "bash" },
    { kind: "shell", tool: "shell", shell: "bash", command: 42 },
    { kind: "shell", tool: "shell", shell: "bash", command: "ls", truncated: "true" },
    { kind: "shell", tool: "shell", shell: "bash", command: `echo ${"x".repeat(4_096)}` },
  ];

  for (const input of malformed) {
    const decision = new AutoModeGate().evaluate(input);
    assert.equal(decision.effect, "deny");
    assert.equal(decision.blocked, true);
  }
});

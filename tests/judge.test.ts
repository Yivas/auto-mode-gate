import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AutoModeGate,
  PERMISSION_JUDGE_INSTRUCTION_V1,
  buildPermissionJudgeRequest,
  validatePermissionJudgeResponse,
} from "../src/index.ts";
import type {
  NormalizedShellAction,
  PermissionJudgeSanitizedRequest,
} from "../src/index.ts";

interface PrivacyFixture {
  readonly name: string;
  readonly action: NormalizedShellAction;
  readonly expected: PermissionJudgeSanitizedRequest | null;
  readonly forbidden: readonly string[];
}

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/judge-privacy.json", import.meta.url), "utf8"),
) as PrivacyFixture[];

for (const fixture of fixtures) {
  test(`judge privacy: ${fixture.name}`, () => {
    const request = buildPermissionJudgeRequest(fixture.action, ["/trusted/bin/git"]);

    assert.deepEqual(request ?? null, fixture.expected);
    if (!request) {
      return;
    }

    const serialized = JSON.stringify(request);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= 512);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.optionRisks), true);
    assert.equal(Object.isFrozen(request.argumentKinds), true);
    for (const forbidden of fixture.forbidden) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });
}

test("judge request limits fail closed", () => {
  const base = "/trusted/bin/git show";
  const trustedPaths = ["/trusted/bin/git"];

  assert.equal(
    buildPermissionJudgeRequest(
      action(`${base} ${Array(9).fill("--quiet").join(" ")}`),
      trustedPaths,
    ),
    undefined,
  );
  assert.equal(
    buildPermissionJudgeRequest(
      action(`${base} ${Array(9).fill("value").join(" ")}`),
      trustedPaths,
    ),
    undefined,
  );
  assert.equal(
    buildPermissionJudgeRequest(action(`${base} ${"x".repeat(257)}`), trustedPaths),
    undefined,
  );
  assert.equal(
    buildPermissionJudgeRequest(action(`${base} ${"x".repeat(4_097)}`), trustedPaths),
    undefined,
  );
  assert.equal(buildPermissionJudgeRequest(action(`${base} value`), []), undefined);
});

test("permission judge instruction is static and auditable", () => {
  assert.equal(
    PERMISSION_JUDGE_INSTRUCTION_V1,
    [
      "Allow only a clearly read-only, local action with no execution or state change.",
      "Deny if the operation, option risks, or argument kinds leave any uncertainty.",
      "Return exactly one JSON object and no other text:",
      '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
      "or",
      '{"protocol":"amg-permission-judge/v1","verdict":"deny"}',
    ].join("\n"),
  );
});

test("permission judge response validation accepts only canonical JSON", () => {
  assert.deepEqual(
    validatePermissionJudgeResponse(
      '  {"protocol":"amg-permission-judge/v1","verdict":"allow"}\n',
    ),
    {
      status: "response",
      response: { protocol: "amg-permission-judge/v1", verdict: "allow" },
    },
  );
  assert.deepEqual(
    validatePermissionJudgeResponse(
      '{"protocol":"amg-permission-judge/v1","verdict":"deny"}',
    ),
    {
      status: "response",
      response: { protocol: "amg-permission-judge/v1", verdict: "deny" },
    },
  );

  const invalid: unknown[] = [
    null,
    {},
    "allow",
    '{ "protocol": "amg-permission-judge/v1", "verdict": "allow" }',
    '{"verdict":"allow","protocol":"amg-permission-judge/v1"}',
    '{"protocol":"amg-permission-judge/v1","verdict":"unknown"}',
    '{"protocol":"amg-permission-judge/v1","verdict":"allow","extra":true}',
    '```json\n{"protocol":"amg-permission-judge/v1","verdict":"allow"}\n```',
    '{"protocol":"amg-permission-judge/v1","verdict":"allow"} trailing',
    "x".repeat(257),
  ];

  for (const value of invalid) {
    assert.deepEqual(validatePermissionJudgeResponse(value), { status: "invalid-response" });
  }
});

test("judge data never enters current decisions, logs, or validator errors", () => {
  const secret = "fictional-secret-7f3a9c";
  const request = buildPermissionJudgeRequest(
    action(`/trusted/bin/git show ${secret}`),
    ["/trusted/bin/git"],
  );
  const decision = new AutoModeGate({
    mode: "enforce",
    trustedExecutablePaths: ["/trusted/bin/git"],
  }).evaluate(action(`/trusted/bin/git show ${secret}`));
  const invalid = validatePermissionJudgeResponse(`fictional-response-${secret}`);
  const serialized = JSON.stringify({ decision, invalid });

  assert.ok(request);
  assert.equal(JSON.stringify(request).includes(secret), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(PERMISSION_JUDGE_INSTRUCTION_V1), false);
});

function action(command: string): NormalizedShellAction {
  return {
    kind: "shell",
    tool: "shell",
    shell: "bash",
    command,
    executable: {
      name: "git",
      path: "/trusted/bin/git",
      source: "trusted-path",
    },
    host: "pi",
  };
}

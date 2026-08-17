import { MAX_SHELL_COMMAND_LENGTH } from "./limits.ts";
import { normalizeExecutableName, parseShellCommand } from "./shell.ts";
import type {
  NormalizedShellAction,
  PermissionJudgeArgumentKind,
  PermissionJudgeOperation,
  PermissionJudgeOptionRisk,
  PermissionJudgeOutcome,
  PermissionJudgeResponse,
  PermissionJudgeSanitizedRequest,
} from "./types.ts";

const MAX_TOKEN_BYTES = 256;
const MAX_OPTIONS = 8;
const MAX_ARGUMENTS = 8;
const MAX_REQUEST_BYTES = 512;
const MAX_RESPONSE_BYTES = 256;

const operations = new Set<PermissionJudgeOperation>(["diff", "log", "show", "status"]);

const optionRisks = new Map<string, PermissionJudgeOptionRisk>([
  ["--quiet", "read-modifier"],
  ["--short", "read-modifier"],
  ["--stat", "read-modifier"],
  ["--name-only", "read-modifier"],
  ["--name-status", "read-modifier"],
  ["--oneline", "read-modifier"],
  ["--decorate", "read-modifier"],
  ["--no-patch", "read-modifier"],
  ["--patch", "read-modifier"],
  ["--cached", "read-modifier"],
  ["--staged", "read-modifier"],
  ["-q", "read-modifier"],
  ["--output", "write"],
  ["--write", "write"],
  ["-o", "write"],
  ["--exec", "execute"],
  ["--execute", "execute"],
  ["--remote", "network"],
  ["--upload", "network"],
  ["--download", "network"],
  ["--force", "force"],
  ["-f", "force"],
  ["--recursive", "recursive"],
  ["-r", "recursive"],
  ["--token", "credential"],
  ["--password", "credential"],
  ["--authorization", "credential"],
  ["--cookie", "credential"],
  ["--api-key", "credential"],
]);

const canonicalResponses = {
  allow: '{"protocol":"amg-permission-judge/v1","verdict":"allow"}',
  deny: '{"protocol":"amg-permission-judge/v1","verdict":"deny"}',
} as const;

export const PERMISSION_JUDGE_INSTRUCTION_V1 = [
  "Allow only a clearly read-only, local action with no execution or state change.",
  "Deny if the operation, option risks, or argument kinds leave any uncertainty.",
  "Return exactly one JSON object and no other text:",
  canonicalResponses.allow,
  "or",
  canonicalResponses.deny,
].join("\n");

export function buildPermissionJudgeRequest(
  action: NormalizedShellAction,
  trustedExecutablePaths: readonly string[],
): PermissionJudgeSanitizedRequest | undefined {
  try {
    if (
      action.kind !== "shell" ||
      action.tool !== "shell" ||
      typeof action.command !== "string" ||
      action.command.length > MAX_SHELL_COMMAND_LENGTH ||
      action.truncated === true ||
      hasAdjacentQuotes(action.command) ||
      !hasMatchingExecutableIdentity(action, trustedExecutablePaths)
    ) {
      return undefined;
    }

    const parsed = parseShellCommand(action.shell, action.command);
    if (parsed.status !== "parsed" || parsed.tokens.length < 2) {
      return undefined;
    }
    if (parsed.tokens.some((token) => Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES)) {
      return undefined;
    }

    const operation = parsed.tokens[1].toLowerCase();
    if (!isPermissionJudgeOperation(operation)) {
      return undefined;
    }

    const risks: PermissionJudgeOptionRisk[] = [];
    const argumentsSeen: PermissionJudgeArgumentKind[] = [];
    for (const token of parsed.tokens.slice(2)) {
      if (token.startsWith("-")) {
        const risk = readOptionRisk(token);
        if (!risk || risks.length >= MAX_OPTIONS) {
          return undefined;
        }
        risks.push(risk);
        continue;
      }

      if (argumentsSeen.length >= MAX_ARGUMENTS) {
        return undefined;
      }
      argumentsSeen.push(classifyArgument(token));
    }

    const request = {
      protocol: "amg-permission-judge/v1",
      shell: action.shell,
      executable: "git",
      operation,
      optionRisks: Object.freeze(risks),
      argumentKinds: Object.freeze(argumentsSeen),
      syntax: "simple-literal",
    } as const;
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REQUEST_BYTES) {
      return undefined;
    }
    return Object.freeze(request);
  } catch {
    return undefined;
  }
}

export function validatePermissionJudgeResponse(input: unknown): PermissionJudgeOutcome {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_RESPONSE_BYTES) {
    return invalidResponse();
  }

  const response = input.trim();
  if (response === canonicalResponses.allow) {
    return validResponse("allow");
  }
  if (response === canonicalResponses.deny) {
    return validResponse("deny");
  }
  return invalidResponse();
}

function hasMatchingExecutableIdentity(
  action: NormalizedShellAction,
  trustedExecutablePaths: readonly string[],
): boolean {
  const identity = action.executable;
  if (
    !identity ||
    identity.source !== "trusted-path" ||
    !isAbsolutePath(identity.path) ||
    !trustedExecutablePaths.includes(identity.path)
  ) {
    return false;
  }

  const parsed = parseShellCommand(action.shell, action.command);
  const executableToken = parsed.tokens[0];
  const expectedName = normalizeExecutableName(executableToken);
  return (
    parsed.status === "parsed" &&
    executableToken === identity.path &&
    expectedName === "git" &&
    identity.name === expectedName
  );
}

function hasAdjacentQuotes(command: string): boolean {
  return /(?:''|""|'"|"')/u.test(command);
}

function readOptionRisk(token: string): PermissionJudgeOptionRisk | undefined {
  const separator = token.indexOf("=");
  const name = (separator < 0 ? token : token.slice(0, separator)).toLowerCase();
  return optionRisks.get(name);
}

function classifyArgument(token: string): PermissionJudgeArgumentKind {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(token)) {
    return "url";
  }
  if (
    token.startsWith("/") ||
    token.startsWith("\\\\") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    /^[a-z]:[\\/]/iu.test(token) ||
    token.includes("/") ||
    token.includes("\\")
  ) {
    return "path";
  }
  if (/^[+-]?(?:\d+|\d*\.\d+)$/u.test(token)) {
    return "number";
  }
  return "value";
}

function validResponse(verdict: "allow" | "deny"): PermissionJudgeOutcome {
  const response: PermissionJudgeResponse = Object.freeze({
    protocol: "amg-permission-judge/v1",
    verdict,
  });
  return Object.freeze({ status: "response", response });
}

function invalidResponse(): PermissionJudgeOutcome {
  return Object.freeze({ status: "invalid-response" });
}

function isPermissionJudgeOperation(value: string): value is PermissionJudgeOperation {
  return operations.has(value as PermissionJudgeOperation);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\");
}

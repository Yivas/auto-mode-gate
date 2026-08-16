import type { Shell } from "./types.ts";

export interface ParsedCommand {
  readonly status: "parsed" | "ambiguous" | "invalid";
  readonly tokens: readonly string[];
}

const shellRules = {
  bash: {
    quotes: ["'", '"'],
    escape: "\\",
    forbidden: new Set([
      ";",
      "|",
      "&",
      "<",
      ">",
      "\n",
      "\r",
      "`",
      "$",
      "*",
      "?",
      "[",
      "]",
      "{",
      "}",
      "~",
      "!",
      "(",
      ")",
    ]),
  },
  powershell: {
    quotes: ["'", '"'],
    escape: "`",
    forbidden: new Set([
      ";",
      "|",
      "&",
      "<",
      ">",
      "\n",
      "\r",
      "$",
      "@",
      "(",
      ")",
      "{",
      "}",
      "*",
      "?",
      "[",
      "]",
    ]),
  },
  cmd: {
    quotes: ['"'],
    escape: "^",
    forbidden: new Set([
      "&",
      "|",
      "<",
      ">",
      "\n",
      "\r",
      "%",
      "!",
      "(",
      ")",
      "*",
      "?",
      "[",
      "]",
    ]),
  },
} as const;

export function normalizeExecutableName(executable: string): string {
  const name = executable.split(/[\\/]/u).at(-1) ?? "";
  return name.toLowerCase().replace(/\.(?:bat|cmd|com|exe)$/u, "");
}

export function parseShellCommand(shell: Shell, command: string): ParsedCommand {
  const rules = shellRules[shell];
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  let ambiguous =
    shell === "cmd"
      ? /[%!*?\[\]]/u.test(command)
      : shell === "powershell" && /[*?\[\]]/u.test(command);
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      if (character === "\n" || character === "\r") {
        ambiguous = true;
      } else {
        token += character;
        tokenStarted = true;
      }
      escaped = false;
      continue;
    }

    if (character === rules.escape) {
      const escapeIsLiteral = quote === "'" || (shell === "cmd" && quote !== "");
      if (escapeIsLiteral) {
        token += character;
      } else {
        escaped = true;
      }
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        if (command[index + 1] === quote) {
          ambiguous = true;
          token += quote;
          tokenStarted = true;
          index += 1;
        } else {
          quote = "";
        }
      } else {
        if (isQuotedExpansion(shell, quote, character)) {
          ambiguous = true;
        }
        token += character;
        tokenStarted = true;
      }
      continue;
    }

    if ((rules.quotes as readonly string[]).includes(character)) {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (rules.forbidden.has(character as never)) {
      ambiguous = true;
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    token += character;
    tokenStarted = true;
  }

  if (escaped || quote) {
    return { status: "invalid", tokens };
  }

  if (tokenStarted) {
    tokens.push(token);
  }

  if (tokens.length === 0) {
    return { status: "invalid", tokens };
  }

  return { status: ambiguous ? "ambiguous" : "parsed", tokens };
}

function isQuotedExpansion(shell: Shell, quote: string, character: string): boolean {
  if (shell === "bash") {
    return quote === '"' && (character === "$" || character === "`");
  }

  if (shell === "powershell") {
    return (quote === '"' && character === "$") || ["*", "?", "[", "]"].includes(character);
  }

  return ["%", "!", "*", "?", "[", "]"].includes(character);
}

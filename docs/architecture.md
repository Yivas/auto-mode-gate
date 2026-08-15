# Architecture

This document defines the implemented core and the planned adapter boundaries.

## Decision flow

```text
host tool call
└─ host adapter
   ├─ normalize available action and context
   └─ shared core
      ├─ deterministic allow, deny, or ambiguous
      ├─ fail-closed denial for ambiguous actions
      ├─ repeated-rejection tracking
      └─ structured decision and sanitized log record
   └─ host enforcement
      ├─ allow: continue
      └─ deny: block
```

## Shared core

`src/` contains plain TypeScript with no OpenCode, Pi, or model-provider imports. It analyzes a
normalized action and returns a decision; it does not execute commands, display UI, contact a
network service, or persist state.

The shell analyzer accepts one simple Bash, PowerShell, or CMD command. It rejects malformed input
and treats operators, redirections, substitutions, expansions, untrusted executable paths, and
unsupported commands as ambiguous. The policy allows only a narrow set of read-only commands when the command
uses an absolute executable path, that exact path appears in the global trusted-path allowlist, and
the adapter supplies the same path and canonical name. Bare command names, shell builtins, and
unconfigured absolute paths remain ambiguous because aliases, functions, path resolution, or an
arbitrary same-named binary can replace the expected program. Known mutating or process-launching
commands remain denied without requiring resolution evidence.

Deterministic precedence is:

1. internal evaluation error;
2. unknown action or shell;
3. missing, truncated, oversized, or malformed input;
4. explicit dangerous command or option;
5. missing or mismatched executable identity;
6. unsupported or ambiguous syntax;
7. narrow safe-command allowance.

Every result other than `allow` has a stable denial code. `ambiguous` uses
`AMG_DENY_AMBIGUOUS` and has a final `deny` effect.

The rejection tracker hashes an equivalence key and keeps at most 1,024 counts in memory. The hash
is not returned or written to the log. Log records contain only normalized enums, the stable code,
mode, block result, and rejection count. They exclude commands, arguments, context, prompts, secrets,
and identifiers.

## Configuration and modes

The logical core configuration supports `off`, `shadow`, and `enforce`:

- `off` and `shadow` still compute the policy effect but never report an action as blocked;
- `shadow` records what enforcement would decide and is not a security control;
- `enforce` reports denied actions as blocked.

Global configuration also owns the exact absolute paths eligible for narrow read-only allowances.
Project configuration may remove trusted paths but cannot add one absent from the global list. It
may tighten `shadow` to `enforce`, cannot activate a globally disabled gate, and cannot relax
`enforce`. Invalid modes fall back to `enforce`; invalid trusted-path lists become empty.

## Adapters

Adapters remain planned. They will load host-specific configuration, collect only verified context,
resolve command identity without trusting aliases or shell functions, require a path explicitly
trusted by global configuration, replace the executable token with that exact absolute path,
normalize the tool call, invoke the core, and enforce the same bound invocation. They will not
contain duplicate risk policy.

The OpenCode adapter is planned around `tool.execute.before`. The Pi adapter is planned around
`tool_call`. Pi's `ctx.ui.confirm` remains a tested capability for a future policy path.

An adapter must declare missing capabilities. It must never invent agent identity, session
ancestry, arguments, objectives, or recent actions.

## Deferred permission judge

V1 does not define or invoke a model judge. Isolated probes found a Pi-specific model call, but no
equivalent safe OpenCode API or host-neutral transport was verified. The core therefore converts
every ambiguous result into a denial with a stable reason code.

A later version may add a user-selected model after both hosts have a tested transport with tool
isolation, recursion prevention, authentication, cancellation, timeout, and strict output
validation. A judge will never override a deterministic denial.

## Excluded systems

This project does not include Swarm's architect, coder, reviewer, planning, phases, `.swarm`
state, memory, QA, worktrees, council, or multi-agent orchestration. It is not an operating-system
sandbox, a remote policy service, or a replacement for native host permissions.

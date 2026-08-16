# Architecture

This document defines the implemented core and adapter boundaries.

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
and identifiers. When the global file sets an absolute `logPath`, the adapter appends these records
as JSONL. A write failure becomes a sanitized internal error; it blocks in `enforce` mode.

## Configuration and modes

The logical core configuration supports `off`, `shadow`, and `enforce`:

- `off` and `shadow` still compute the policy effect but never report an action as blocked;
- `shadow` records what enforcement would decide and is not a security control;
- `enforce` reports denied actions as blocked.

`src/config.ts` discovers a global `auto-mode-gate/config.json` through `XDG_CONFIG_HOME`, Windows
`APPDATA`, or `~/.config`, then reads `.auto-mode-gate.json` from the project root. The global file
owns the shell, mode, exact trusted executable paths, and optional log path. Project configuration
may remove trusted paths and tighten `shadow` to `enforce`; it cannot set the shell or log path, add
trust absent from the global file, activate a globally disabled gate, or relax `enforce`.

Both files use strict JSON keys and paths that are absolute for the current operating system.
Relative configuration roots, cross-platform path forms, malformed JSON, unreadable files, and
unknown keys fail closed. Missing global configuration defaults to `enforce` without shell evidence
or trusted paths. Runtime adapters load the files when they start, so changes require a host restart
or reload.

## Adapters

`src/adapter.ts` contains the shared host boundary. It merges logical global/project configuration,
requires an explicitly configured shell, and invokes the core. An executable is trusted only when
the command already starts with the exact configured absolute path. Bare names, relative paths,
unsupported or missing shells, and malformed input fail closed. The adapters do not resolve `PATH`
or rewrite commands because the pinned hooks do not guarantee that a rewritten string identifies
the executable the operating system will open.

`src/opencode.ts` implements the OpenCode `tool.execute.before` contract fixed in
[`compatibility.md`](compatibility.md). It handles the `bash` tool and throws a sanitized denial when
`decision.blocked` is true. `src/opencode-runtime.ts` supplies the loader-facing plugin and binds the
project directory to file discovery. Other tools remain under native OpenCode permissions.

`src/pi.ts` implements Pi's `tool_call` contract. It handles the built-in `bash` tool and returns
`{ block: true, reason }` when enforcement blocks. `src/pi-runtime.ts` resolves configuration from
the event context and caches one adapter per project directory. Pi's `ctx.ui.confirm` remains
unused in v1; ambiguous calls block even when UI exists.

The adapters retain source-level factories for tests and embedding. The runtime entries add strict
file discovery without modifying host settings. OpenCode and Pi activate independently through
small loader files. `off` and `shadow` preserve the core's non-blocking behavior; project
configuration cannot relax global policy or add trusted paths.

Each host process must load its adapter. The hooks do not provide verified child-process identity
or guarantee that a separately launched child loaded the gate. The adapters do not infer session
ancestry, agent identity, arguments, objectives, or recent actions.

Trusted paths are configuration authority, not immutable file identity. Users must control each
trusted file and its ancestor directories. The hooks cannot hold an executable handle across the
decision and execution, so replacement of a trusted file remains outside this gate's guarantees.

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

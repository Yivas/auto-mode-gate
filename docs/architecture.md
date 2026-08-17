# Architecture

This document defines the implemented core and adapter boundaries.

## Decision flow

```text
host tool call
└─ host adapter
   ├─ normalize available action and context
   └─ shared core
      ├─ deterministic assessment
      │  ├─ allow-final
      │  ├─ deny-final
      │  ├─ unresolved-ineligible
      │  └─ unresolved-eligible
      │     ├─ Pi session active: one isolated judge call
      │     └─ unavailable/failure: deny
      └─ single finalization
         ├─ repeated-rejection tracking
         └─ structured decision and sanitized log record
   └─ host enforcement
      ├─ allow: continue
      └─ deny: block
```

## Shared core

`src/` contains plain TypeScript with no OpenCode, Pi, or model-provider imports. It assesses a
normalized action, then finalizes its effect, rejection count, code, denial, and sanitized log once.
It does not execute commands, display UI, contact a network service, or persist state.

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

Every result other than `allow` has a stable denial code. Ambiguous input that cannot produce a
closed sanitized request becomes `unresolved-ineligible` and finalizes as `AMG_DENY_AMBIGUOUS`.
Eligible Git candidates use Pi's judge only in an authorized, active session. Missing transport,
model, cancellation, timeout, error, or invalid output finalizes as a stable denial. Embedders that
call `evaluateWithJudge` directly must supply and enforce an `AbortSignal`; the independent local
deadline belongs to the Pi transport boundary.

The rejection tracker hashes an equivalence key and keeps at most 1,024 counts in memory. The hash
is not returned or written to the log. Log records contain only normalized enums, the stable code,
mode, block result, and rejection count. They exclude commands, arguments, context, prompts, secrets,
and identifiers. When the global file sets an absolute `logPath`, the adapter appends these records
as JSONL. Decision callbacks must complete synchronously; a thrown error or returned promise fails
closed instead of escaping as an unhandled rejection. A write failure becomes a sanitized internal
error and blocks in `enforce` mode.

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

Both files use strict JSON keys and paths that are absolute for the current operating system. A
configuration file may contain at most 64 KiB, and each trusted-path list may contain at most 256
entries. Relative configuration roots, cross-platform path forms, malformed JSON, unreadable or
oversized files, and unknown keys fail closed. Missing global configuration defaults to `enforce`
without shell evidence or trusted paths. Runtime adapters load the files when they start, so changes
require a host restart or reload.

The optional global `permissionJudge` block authorizes the capability only when it contains
`enabled: true`, a provider/model reference, and an integer timeout from 1,000 through 120,000 ms.
Missing or malformed authorization disables the judge. Project configuration can set
`enabled: false` or reduce the timeout; attempts to enable, change the model, or increase the
timeout disable the capability.

## Adapters

`src/adapter.ts` contains the shared host boundary. It merges logical global/project configuration,
requires an explicitly configured shell, and invokes the core. An executable is trusted only when
the command already starts with the exact configured absolute path. Bare names, relative paths,
unsupported or missing shells, and malformed input fail closed. The adapters do not resolve `PATH`
or rewrite commands because the pinned hooks do not guarantee that a rewritten string identifies
the executable the operating system will open.

`src/opencode.ts` implements the OpenCode `tool.execute.before` contract fixed in
[`compatibility.md`](compatibility.md). It handles the `bash` tool and throws a sanitized denial when
`decision.blocked` is true. After an enforced allowance, the hook freezes the original argument
object; a later pre-tool plugin therefore cannot replace the command that the gate reviewed.
`src/opencode-runtime.ts` supplies the loader-facing plugin and binds the project directory to file
discovery. Missing project context installs a fail-closed hook. Other tools remain under native
OpenCode permissions.

`src/pi.ts` implements Pi's async `tool_call` contract. It handles the built-in `bash` tool and
awaits one isolated judge call before returning allow or `{ block: true, reason }`. The transport
uses Pi's selected model registry, a new context with `tools: []`, no history, `maxRetries: 0`, host
cancellation, and an independent local deadline. Tool-call output, oversized or malformed message
shapes, parsing that crosses the deadline, late completion, invalid text, and provider failures
block. An enforced allowance freezes Pi's mutable input object before later `tool_call` handlers run.
`src/pi-runtime.ts` resolves configuration from the event context and keeps at most 32 project
runtimes. Missing project context blocks.

The adapters retain source-level factories for tests and embedding. The runtime entries add strict
file discovery without modifying host settings. OpenCode and Pi activate independently through the
npm package or small source loader files. `off` and `shadow` preserve the core's non-blocking
behavior; project configuration cannot relax global policy or add trusted paths.

Each host process must load its adapter. The hooks do not provide verified child-process identity
or guarantee that a separately launched child loaded the gate. The adapters do not infer session
ancestry, agent identity, arguments, objectives, or recent actions.

Trusted paths are configuration authority, not immutable file identity. Users must control each
trusted file and its ancestor directories. The hooks cannot hold an executable handle across the
decision and execution, so replacement of a trusted file remains outside this gate's guarantees.

## Permission judge

The core defines host-neutral judge types and a pure sanitizer boundary. It accepts only simple
literal Git `diff`, `log`, `show`, or `status` candidates whose exact executable path is configured
and bound by the adapter. Requests contain closed operation, option-risk, and argument-kind enums;
they exclude command text, executable paths, values, URLs, secrets, host context, and identifiers.
A strict validator accepts only the two canonical protocol responses. Pi invokes the model only
when global configuration authorizes it and the current session is active. OpenCode has no verified
transport and maps the same eligible case to `AMG_DENY_JUDGE_UNAVAILABLE`.

Pi registers `/amg-judge` controls for session status, activation, model selection, and reset. State
is keyed by Pi's session-manager object, starts disabled, and is never written to settings or session
JSONL. Model selection uses `find()` and `getAvailable()` without changing the primary model.

Deterministic allowances, denials, ineligible cases, and `off`/`shadow` skip the model. Only eligible
unresolved cases receive minimal normalized context, and a judge never overrides a deterministic
denial. Tests cover isolation, no recursion, local timeout, cancellation races, late resolution,
strict output validation, and one final decision/log.

## Excluded systems

This project does not include multi-agent orchestration, agent roles, planning phases, shared
memory, QA coordination, worktrees, councils, or orchestration state. It is not an operating-system
sandbox, a remote policy service, or a replacement for native host permissions.

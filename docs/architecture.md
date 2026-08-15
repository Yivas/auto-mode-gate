# Planned Architecture

This document defines the intended boundaries. No implementation exists yet.

## Decision flow

```text
host tool call
└─ host adapter
   ├─ normalize available action and context
   └─ shared core
      ├─ deterministic allow, deny, or ambiguous
      ├─ permission judge for ambiguous actions only
      ├─ repeated-rejection tracking
      └─ structured decision and sanitized log record
   └─ host enforcement
      ├─ allow: continue
      ├─ deny: block
      └─ ask: confirm when supported, otherwise block
```

## Shared core

The planned core will be plain TypeScript with no OpenCode, Pi, or model-provider imports. It will
analyze normalized actions and return decisions; it will not execute tools, display UI, or mutate
host state.

Minimum responsibilities:

- normalize the policy inputs required by both hosts;
- analyze Bash, PowerShell, and CMD without execution;
- apply deterministic risk and permission rules;
- invoke a generic judge contract only for ambiguous actions;
- validate judge output and enforce timeout behavior;
- identify repeated equivalent rejections;
- produce stable reason codes, safe messages, and sanitized log fields.

## Adapters

Adapters will load host-specific configuration, collect only verified context, normalize tool
calls, invoke the core, and enforce its result. They will not contain duplicate risk policy.

The OpenCode adapter is planned around `tool.execute.before`. The Pi adapter is planned around
`tool_call`, with `ctx.ui.confirm` for user confirmation when UI is available.

An adapter must declare missing capabilities. It must never invent agent identity, session
ancestry, arguments, objectives, or recent actions.

## Permission judge

The core will define a strict request and response contract. The model is selected by the user;
the project will not hard-code one. The transport remains undecided until current host-native paths
are tested for recursion, tool isolation, authentication, cancellation, timeout, and error
handling.

The judge cannot override deterministic denials. Missing judge support, timeout, malformed output,
or an internal error yields a safe denial or user confirmation where the adapter supports it.

## Configuration and modes

The logical configuration will support global and project scopes, independent adapter activation,
judge model selection, timeouts, log settings, and `off`, `enforce`, and `shadow` modes. Project
configuration may tighten global policy but must not relax deterministic denials.

Shadow mode records what the gate would decide and never claims to protect the host.

## Excluded systems

This project will not include Swarm's architect, coder, reviewer, planning, phases, `.swarm`
state, memory, QA, worktrees, council, or multi-agent orchestration. It is not an operating-system
sandbox, a remote policy service, or a replacement for native host permissions.

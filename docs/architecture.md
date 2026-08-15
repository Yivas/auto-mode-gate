# Planned Architecture

This document defines the intended boundaries. No implementation exists yet.

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

The planned core will be plain TypeScript with no OpenCode, Pi, or model-provider imports. It will
analyze normalized actions and return decisions; it will not execute tools, display UI, or mutate
host state.

Minimum responsibilities:

- normalize the policy inputs required by both hosts;
- analyze Bash, PowerShell, and CMD without execution;
- apply deterministic risk and permission rules;
- deny ambiguous actions with a stable reason code;
- identify repeated equivalent rejections;
- produce stable reason codes, safe messages, and sanitized log fields.

## Adapters

Adapters will load host-specific configuration, collect only verified context, normalize tool
calls, invoke the core, and enforce its result. They will not contain duplicate risk policy.

The OpenCode adapter is planned around `tool.execute.before`. The Pi adapter is planned around
`tool_call`. Pi's `ctx.ui.confirm` remains a tested capability for a future policy path.

An adapter must declare missing capabilities. It must never invent agent identity, session
ancestry, arguments, objectives, or recent actions.

## Deferred permission judge

V1 will not define or invoke a model judge. Isolated probes found a Pi-specific model call, but no
equivalent safe OpenCode API or host-neutral transport was verified. The core therefore converts
every ambiguous result into a denial with a stable reason code.

A later version may add a user-selected model after both hosts have a tested transport with tool
isolation, recursion prevention, authentication, cancellation, timeout, and strict output
validation. A judge will never override a deterministic denial.

## Configuration and modes

The logical configuration will support global and project scopes, independent adapter activation,
log settings, and `off`, `enforce`, and `shadow` modes. Project configuration may tighten global
policy but must not relax deterministic denials.

Shadow mode records what the gate would decide and never claims to protect the host.

## Excluded systems

This project will not include Swarm's architect, coder, reviewer, planning, phases, `.swarm`
state, memory, QA, worktrees, council, or multi-agent orchestration. It is not an operating-system
sandbox, a remote policy service, or a replacement for native host permissions.

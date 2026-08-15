# Upstream Provenance

## OpenCode Swarm

- Source: <https://github.com/ZaxbyHub/opencode-swarm>
- Revision: `50033bc1e0a0d943433701042fed90b2a791f7fe`
- License: MIT
- Copyright notice: `Copyright (c) 2025`

The initial design study examined these areas:

| Capability | Upstream location | Current status |
|-|-|-|
| Deterministic policy and structured denials | `src/full-auto/policy.ts` | Design reference only |
| Pre-tool enforcement | `src/hooks/full-auto-permission.ts` | Design reference only |
| Rejection counters and fail-closed state | `src/full-auto/state.ts` | Design reference only |
| Critic oversight | `src/full-auto/oversight.ts` | Requirements only; implementation excluded |
| Shell analysis | `src/hooks/shell-write-detect.ts` | Pending symbol-level review |
| Guardrail enforcement | `src/hooks/guardrails/tool-before.ts` | Fail-closed behavior reference |

No upstream source code is present in the documentation-only scaffold.

## Extraction rule

Before a future change copies or adapts code:

1. Record the exact upstream file, symbol, and revision.
2. Review transitive dependencies and licenses.
3. Choose reimplementation when it produces a smaller independent result.
4. Preserve the MIT notice for copied or substantially adapted portions.
5. Update this document and `NOTICE` in the same commit.

## Explicit exclusions

Architect, coder, reviewer, planning, phases, phase approval, `.swarm`, memory, QA, worktrees,
council, cadence, evidence storage, task state, and every other multi-agent orchestration feature
remain outside this repository.

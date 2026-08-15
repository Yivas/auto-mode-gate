# Compatibility Baseline

Auto Mode Gate has no supported release yet. The versions below are research baselines, not
compatibility claims.

| Host | Evidence baseline | Pre-execution hook | User confirmation | Current design consequence |
|-|-|-|-|-|
| OpenCode | `dev` `4643e65ad6334de3e4e68dedc201d5fbb828c9fe`; release tag `v1.18.18` | `tool.execute.before` | No synchronous generic plugin dialog verified | `ask` blocks |
| Pi | `v0.84.2`, `914cf1472e715297caa30db4b9535d534a9eb718` | `tool_call` | `ctx.ui.confirm` when UI is available | `ask` confirms or blocks |

## Sources

OpenCode:

- [`Hooks` at the researched commit](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/plugin/src/index.ts)
- [Pre-tool hook invocation](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/opencode/src/session/tools.ts)
- [Official plugin documentation](https://opencode.ai/docs/plugins/)

Pi:

- [`tool_call` and extension context types at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/extensions/types.ts)
- [Official extension lifecycle documentation at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md)
- [Official permission-gate example at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/examples/extensions/permission-gate.ts)

## Semantic parity

Both adapters must use the same policy fixtures and reason codes. A host with fewer capabilities
must never grant broader permission. Interaction may differ:

- Pi can ask once before an ambiguous action when UI is available.
- OpenCode blocks the same `ask` verdict until a synchronous API is publicly available and tested.

## Known limits

- Passing the gate does not bypass or replace native host permissions.
- Agent and subagent identity is used only when the host provides verifiable evidence.
- Pi does not provide native subagent identity; child processes must load their own adapter.
- OpenCode's researched pre-tool hook does not include agent identity or an abort signal.
- Neither researched extension API provides one common isolated model-invocation method.
- Coverage is limited to execution paths proven to pass through the documented hooks.

## Before claiming support

Each supported release must pass isolated integration tests that prove the hook blocks before a
stub side effect, timeout and error paths fail closed, configuration does not overwrite user files,
and removal leaves unrelated configuration unchanged.

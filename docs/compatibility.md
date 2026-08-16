# Compatibility Baseline

Auto Mode Gate 0.1.0 is the first public release. The versions below are validated host-contract
baselines, not broad compatibility claims.

| Host | Executed baseline | Pre-execution hook | User confirmation | V1 consequence |
|-|-|-|-|-|
| OpenCode | `v1.18.18`, `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d` | `tool.execute.before` blocked before a stub effect | No synchronous generic plugin dialog verified | `ambiguous` blocks |
| Pi | `v0.84.1`, `53fa77ccd8a279eb87e92294ef3687b03ff80112` | `tool_call` blocked before a stub effect | `ctx.ui.confirm` passed accept, reject, timeout, and no-UI probes | `ambiguous` blocks |

Pi `v0.84.2` at commit `914cf1472e715297caa30db4b9535d534a9eb718` remains a static research
baseline. It was not installed or executed during the isolated probes.

## Sources

OpenCode:

- [`Hooks` at the researched commit](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/plugin/src/index.ts)
- [Pre-tool hook invocation](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/opencode/src/session/tools.ts)
- [`v1.18.18` hook types](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/plugin/src/index.ts)
- [`v1.18.18` pre-tool invocation](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/opencode/src/session/tools.ts)
- [Official plugin documentation](https://opencode.ai/docs/plugins/)

Pi:

- [Release `v0.84.1`](https://github.com/earendil-works/pi/releases/tag/v0.84.1)
- [`tool_call` and extension context types at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/extensions/types.ts)
- [Official extension lifecycle documentation at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md)
- [Official permission-gate example at `v0.84.2`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/examples/extensions/permission-gate.ts)

## Adapter verification

The source-level adapter suite replays the shared policy corpus for both hosts. Host doubles assert
that OpenCode throws and Pi returns a blocking result before a stub effect, that allowed Bash calls
already contain the exact trusted path evaluated by the core, and that `shadow`, `off`, and project
configuration keep the core's restrictions.

These tests exercise the pinned hook shapes without starting either host. The executed baselines in
the table remain evidence for hook ordering; the adapter implementation did not modify or start
active installations.

## Source-install verification

The source-install validation loaded the OpenCode and Pi runtime entries from local checkout URLs
in isolated temporary profiles. OpenCode 1.18.18 discovered the loader through its configured
plugin directory and
reported it through `opencode debug config`; deleting that loader removed it while preserving the
bootstrapped unrelated host configuration byte for byte. OpenCode may consult its public model
catalog during startup.

Pi 0.84.1 loaded the extension from a temporary `PI_CODING_AGENT_DIR` during
`pi --offline --list-models`. Deleting the extension directory disabled it and left unrelated
settings byte for byte unchanged. Neither test read credentials, installed packages, or modified
active host profiles. Runtime tests separately exercised `off`, `shadow`, `enforce`, global/project
precedence, sanitized logs, malformed configuration, and log-write failure through both host entry
points.

## Semantic parity

Both adapters use the same policy fixtures and reason codes. A host with fewer capabilities must
never grant broader permission.

Pi confirmation is a tested adapter capability, but v1 does not expose it for ambiguous actions.
Both adapters block ambiguity while the permission judge is deferred.

## Known limits

- Passing the gate does not bypass or replace native host permissions.
- Agent and subagent identity is used only when the host provides verifiable evidence.
- Pi does not provide native subagent identity; child processes must load their own adapter.
- OpenCode sessions covered by the loaded plugin use the same hook, but a separately launched host
  process must load the plugin itself.
- OpenCode's researched pre-tool hook does not include agent identity or an abort signal.
- Pi 0.84.1 exposes a host-native model call; no equivalent isolated API was verified in OpenCode 1.18.18.
- No common permission-judge transport is enabled in v1.
- Coverage is limited to execution paths proven to pass through the documented hooks.
- Runtime entries discover strict global and project JSON files. The npm package and source
  installation use the same TypeScript entries; a source loader still depends on its checkout path.
- The adapters require explicit shell evidence and do not rewrite bare executable names.
- A trusted path is configuration authority, not an immutable file handle; replacing a trusted file
  between policy evaluation and execution remains outside the hook contract.

## Before claiming support

Each supported release must repeat isolated integration tests that prove the hook blocks before a
stub side effect, timeout and error paths fail closed, configuration does not overwrite user files,
and removal leaves unrelated configuration unchanged. Source-profile results do not authorize a
package release or broader compatibility claim.

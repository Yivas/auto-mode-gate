# Compatibility Baseline

Auto Mode Gate 0.2.0 adds the Pi permission judge while preserving the deterministic 0.1.0 policy.
The versions below are validated host-contract baselines, not broad compatibility claims.

| Host | Executed baseline | Pre-execution hook | `0.1.0` | `0.2.0` |
|-|-|-|-|-|
| OpenCode | `v1.18.18`, `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d` | `tool.execute.before` blocked before a stub effect | All ambiguity blocks | Eligible cases block as judge unavailable |
| Pi | `v0.84.1`, `53fa77ccd8a279eb87e92294ef3687b03ff80112` | `tool_call` blocked before a stub effect | All ambiguity blocks | Authorized active sessions can use one isolated judge call |

Pi `v0.84.2` at commit `914cf1472e715297caa30db4b9535d534a9eb718` was installed only in a
temporary directory and exercised against a loopback OpenAI-compatible server. Ten probe cases
covered async pre-tool waiting, model selection, zero tools, no reentry, timeout, cancellation,
errors, invalid output, missing models, and session reset. No real inference or active profile was
used.

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

The source-level adapter suite replays the shared deterministic and judge corpora. Host doubles
assert that OpenCode throws and Pi returns a blocking result before a stub effect, that allowed Bash
calls already contain the exact trusted path evaluated by the core, and that enforced allowances
freeze the mutable host argument object before later pre-tool handlers run. They also verify that
`shadow`, `off`, project configuration, cancellation, timeout, late completion, invalid output, and
transport errors preserve the core's restrictions.

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
points. Host-owned discovery tests cover independent OpenCode and Pi roots, byte-preserving legacy
migration, destination precedence, invalid sources and destinations, and exclusive publication on
the test filesystem. The migration rejects symlinks and non-regular entries and does not claim
protection when another local actor controls and replaces filesystem ancestors.

## Semantic parity

Both adapters use the same policy fixtures and reason codes. A host with fewer capabilities must
never grant broader permission.

Pi confirmation remains unused. Version 0.2.0 uses Pi's public model registry for one
isolated call when global configuration authorizes the judge and the current session is active.
OpenCode has no equivalent verified transport and returns the same fail-closed unavailable code for
an eligible case.

## Known limits

- Passing the gate does not bypass or replace native host permissions.
- Agent and subagent identity is used only when the host provides verifiable evidence.
- Pi does not provide native subagent identity; child processes must load their own adapter.
- OpenCode sessions covered by the loaded plugin use the same hook, but a separately launched host
  process must load the plugin itself.
- OpenCode's researched pre-tool hook does not include agent identity or an abort signal.
- Pi 0.84.2 exposes the model-registry transport used by version 0.2.0; no equivalent isolated API
  was verified in OpenCode 1.18.18.
- The 0.2.0 judge transport is Pi-specific. Package 0.1.0 remains deterministic-only.
- Only simple literal Git `diff`, `log`, `show`, and `status` requests with a configured exact path
  can become eligible; values, paths, URLs, secrets, host context, and IDs are not transported.
- Coverage is limited to execution paths proven to pass through the documented hooks.
- Runtime entries discover strict host-owned global and project JSON files. A missing destination
  may migrate from the `0.2.0` shared path by an exclusive copy; existing destinations never fall
  back to legacy. Filesystems that cannot create the required same-filesystem hard link fail closed
  and require manual migration. The npm package and source installation use the same TypeScript
  entries; a source loader still depends on its checkout path.
- The adapters require explicit shell evidence and do not rewrite bare executable names.
- A trusted path is configuration authority, not an immutable file handle; replacing a trusted file
  between policy evaluation and execution remains outside the hook contract.

## Before claiming support

Each supported release must repeat isolated integration tests that prove the hook blocks before a
stub side effect, timeout, cancellation, late completion, model absence, invalid output, and error
paths fail closed, configuration does not overwrite user files, and removal leaves unrelated
configuration unchanged. Source-profile and loopback results do not authorize a package release,
real-model inference claim, or broader compatibility claim.

# Auto Mode Gate

Auto Mode Gate is a host-neutral permission gate under development for OpenCode and Pi. It aims
to provide Claude Code Auto Mode-style decisions without depending on the rest of OpenCode Swarm.

## Status

The host-neutral core and source-level OpenCode and Pi adapters are implemented and tested. The
core classifies simple Bash, PowerShell, and CMD commands without executing them, blocks unknown
or ambiguous input, tracks equivalent rejections in memory, and returns sanitized log records. The
repository still has no installable package, command, configuration file discovery, or supported
host release.

Isolated probes have verified the pre-execution hooks in OpenCode 1.18.18 and Pi 0.84.1. No safe,
host-neutral model-judge transport was found, so v1 blocks ambiguous actions instead of invoking a
model.

## Current behavior

```text
action
└─ deterministic policy
   ├─ safe      -> continue
   ├─ dangerous -> block
   └─ ambiguous -> block
```

The shared policy will fail closed. Unknown actions, missing evidence, parser failures, and
internal errors must not grant permission. Any future judge timeout or invalid response must also
block, and a judge must never override a deterministic denial.

## Implemented core

- Host-neutral TypeScript types and structured denial codes.
- Conservative analysis of one simple Bash, PowerShell, or CMD command.
- An exact absolute executable path, matching identity, and explicit global trusted-path entry
  required before any narrow read-only allowance; bare names, shell builtins, and unconfigured
  paths remain ambiguous.
- Deterministic precedence: invalid or unknown input, explicit denials, missing evidence,
  ambiguity, then narrow read-only allowances.
- Fail-closed conversion of `ambiguous` to `deny`.
- In-memory repeated-rejection counts without persistent identifiers.
- Sanitized log records that exclude commands, arguments, context, and secrets.
- `off`, `shadow`, and `enforce` decisions with project configuration allowed to tighten global
  mode and remove, but never add, trusted executable paths.
- One shared conformance corpus and unit tests.

## Implemented adapters

- `src/opencode.ts` registers `tool.execute.before` and throws a sanitized error when enforcement
  blocks.
- `src/pi.ts` registers `tool_call` and returns `{ block: true }` when enforcement blocks.
- Both adapters ignore non-Bash tools, require an explicitly configured shell, block ambiguous Bash
  calls without confirmation, and accept logical global/project configuration through source-level
  factories.
- A safe command must already name the exact trusted absolute executable path. The adapters do not
  resolve `PATH` or rewrite bare names because the pinned hooks do not guarantee executable identity.
- The shared corpus runs against the core and both adapter runtimes. Host doubles verify that a
  denial stops the stub effect before execution.

Adapters are independent: loading one does not load the other. A child host process must load its
own adapter; neither host provides verified child identity through these hooks.

## Host parity

Parity means the same evidence produces the same policy verdict. Host interaction may differ.

- Pi 0.84.1 exposes a blocking `tool_call` event and can request confirmation through its UI.
- OpenCode 1.18.18 exposes `tool.execute.before`, but no synchronous generic confirmation dialog
  was verified for that baseline. Any future `ask` verdict must block on OpenCode.

Pi confirmation remains a tested host capability, not a v1 policy path. V1 blocks ambiguous
actions on both hosts to preserve semantic parity.

See [`docs/compatibility.md`](docs/compatibility.md) for the evidence baseline and limitations.

## Architecture

The policy core is independent from both hosts and imports only Node standard-library modules.
The adapters normalize Bash calls, verify exact configured executable paths, merge logical
global/project configuration, and enforce the returned decision. Configuration-file discovery
remains deferred.
See [`docs/architecture.md`](docs/architecture.md).

## Development

The repository has no installed dependencies. The tests currently run on Node 24.9.0; no broader
runtime compatibility is claimed. Run the core and adapter conformance tests with:

```text
npm test
```

## Upstream and license

The design study uses OpenCode Swarm at commit
[`50033bc1e0a0d943433701042fed90b2a791f7fe`](https://github.com/ZaxbyHub/opencode-swarm/commit/50033bc1e0a0d943433701042fed90b2a791f7fe)
as a reference. OpenCode Swarm is MIT licensed. This is a new standalone repository, not a full
fork, and excludes Swarm's orchestration system.

See [`docs/upstream.md`](docs/upstream.md), [`NOTICE`](NOTICE), and [`LICENSE`](LICENSE).

## Installation, configuration, commands, and removal

Not available. Source-level adapter factories are not an installation contract. Package names,
configuration locations, install/remove commands, and compatibility claims remain deferred until
clean-profile tests exist.

## Participation

Intended mode: open-source maintained under MIT. This local repository has no public remote,
issue tracker, contribution channel, or security contact yet. Those policies must be added before
publication. Pull requests are not accepted during the pre-publication phase.

Auto Mode Gate is an independent project and is not affiliated with Anthropic, OpenCode, Pi, or
OpenCode Swarm.

# Auto Mode Gate

Auto Mode Gate is a planned, host-neutral permission gate for OpenCode and Pi. It aims to provide
Claude Code Auto Mode-style decisions without depending on the rest of OpenCode Swarm.

## Status

**Design scaffold only.** This repository does not contain executable software, an installable
package, commands, or supported configuration. Do not follow third-party installation instructions
that claim otherwise.

Isolated probes have verified the pre-execution hooks in OpenCode 1.18.18 and Pi 0.84.1. No safe,
host-neutral model-judge transport was found, so the first implementation will block ambiguous
actions instead of invoking a model.

## Intended behavior

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

## Planned scope

- Shared permission engine and structured decisions.
- Bash, PowerShell, and CMD analysis without command execution.
- Deterministic risk rules before any model call.
- Sanitized decision logs and repeated-rejection detection.
- Independent OpenCode and Pi adapters using one policy core.
- Global and project configuration, per-host activation, and shadow mode.
- Shared conformance cases plus adapter-specific integration tests.
- Verified installation, configuration, operation, and removal instructions for both hosts.

## Host parity

Parity means the same evidence produces the same policy verdict. Host interaction may differ.

- Pi 0.84.1 exposes a blocking `tool_call` event and can request confirmation through its UI.
- OpenCode 1.18.18 exposes `tool.execute.before`, but no synchronous generic confirmation dialog
  was verified for that baseline. Any future `ask` verdict must block on OpenCode.

Pi confirmation remains a tested host capability, not a v1 policy path. V1 blocks ambiguous
actions on both hosts to preserve semantic parity.

See [`docs/compatibility.md`](docs/compatibility.md) for the evidence baseline and limitations.

## Architecture

The planned repository will keep the policy core independent from both hosts. Adapters will only
load configuration, normalize host calls, provide verified context, and enforce the returned
decision. See [`docs/architecture.md`](docs/architecture.md).

## Upstream and license

The design study uses OpenCode Swarm at commit
[`50033bc1e0a0d943433701042fed90b2a791f7fe`](https://github.com/ZaxbyHub/opencode-swarm/commit/50033bc1e0a0d943433701042fed90b2a791f7fe)
as a reference. OpenCode Swarm is MIT licensed. This is a new standalone repository, not a full
fork, and excludes Swarm's orchestration system.

See [`docs/upstream.md`](docs/upstream.md), [`NOTICE`](NOTICE), and [`LICENSE`](LICENSE).

## Installation, configuration, commands, and removal

Not available. These sections will be written only after the implementation and clean-profile
tests exist. The documentation will not invent package names, file locations, commands, or
compatibility claims.

## Participation

Intended mode: open-source maintained under MIT. This local repository has no public remote,
issue tracker, contribution channel, or security contact yet. Those policies must be added before
publication. Pull requests are not accepted during the pre-implementation phase.

Auto Mode Gate is an independent project and is not affiliated with Anthropic, OpenCode, Pi, or
OpenCode Swarm.

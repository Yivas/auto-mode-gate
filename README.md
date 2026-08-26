<p align="center">
  <img src="https://yivas.github.io/auto-mode-gate/favicon.svg" width="96" height="96" alt="Auto Mode Gate logo">
</p>

<h1 align="center">Auto Mode Gate</h1>

<p align="center">
  Deterministic-first permission control for OpenCode and Pi.
</p>

<p align="center">
  <a href="https://github.com/Yivas/auto-mode-gate/actions/workflows/ci.yml"><img src="https://github.com/Yivas/auto-mode-gate/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/auto-mode-gate"><img src="https://img.shields.io/npm/v/auto-mode-gate?label=npm" alt="npm version"></a>
  <a href="https://github.com/Yivas/auto-mode-gate/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Yivas/auto-mode-gate" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://yivas.github.io/auto-mode-gate/">Documentation</a> ·
  <a href="#install-from-npm">Install</a> ·
  <a href="https://github.com/Yivas/auto-mode-gate/releases/latest">Releases</a> ·
  <a href="https://github.com/Yivas/auto-mode-gate/blob/main/CONTRIBUTING.md">Contributing</a>
</p>

Auto Mode Gate reviews Bash tool calls before they execute. It resolves deterministic policy first,
then sends only eligible unresolved cases to the selected Pi judge. Deterministic denials always
win, and missing or invalid evidence fails closed.

> [!IMPORTANT]
> Auto Mode Gate is not an operating-system sandbox and does not replace native OpenCode or Pi
> permissions. A separately launched child host must load its own adapter.

## Highlights

- Apply deterministic policy before any model-assisted permission decision.
- Allow only narrow read-only commands with an exact trusted executable path; unknown or missing
  evidence fails closed.
- Keep OpenCode and Pi policy under separate host-owned global and project paths, with safe migration
  from the shared 0.2.0 files.
- Persist Pi Auto, judge model, thinking, and shortcuts without changing the primary conversation
  model.
- Record optional sanitized decision metadata without commands, arguments, prompts, secrets,
  session IDs, or telemetry.

## Status

Version 0.4.3 is published on
[npm](https://www.npmjs.com/package/auto-mode-gate) and
[GitHub](https://github.com/Yivas/auto-mode-gate/releases/tag/v0.4.3). It adds a reproducible
OpenCode host check and clarifies discovery versus enforcement without changing the runtime
introduced in 0.4.0. The current validated baselines are:

- OpenCode 1.18.18;
- Pi 0.84.2 for persistent controls and isolated judge transport;
- Node 24.9.0 for the test suite.

Read the [validated-baselines reference](https://yivas.github.io/auto-mode-gate/reference/validated-baselines/)
before treating another version as supported.

## Decision flow

```text
action
└─ deterministic policy
   ├─ safe                     -> continue without AI
   ├─ dangerous                -> block without AI
   ├─ unresolved-ineligible    -> block without AI
   └─ unresolved-eligible
      ├─ active Pi judge allow -> continue
      └─ deny/unavailable/fail -> block
```

A narrow read-only allowance requires an exact absolute executable path present in the global
trusted-path list. Bare names, shell builtins, unsupported syntax, missing evidence, malformed
configuration, and internal errors fail closed. Native host permissions still apply after an
allowance.

Only an eligible Git `diff`, `log`, `show`, or `status` request can reach the Pi judge in `enforce`.
OpenCode has no equivalent isolated model transport and blocks those cases as unavailable. Read
[how decisions work](https://yivas.github.io/auto-mode-gate/guide/decisions/) for the complete
contract.

## Install from npm

Review the package source before installing it. Host plugins and extensions run with the user's
system permissions.

### OpenCode

Declare the package in the `plugin` array of project or global `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["auto-mode-gate@0.4.3"]
}
```

Merge the entry without removing existing plugins or configuration. You can also install it for the
current project:

```text
opencode plugin auto-mode-gate@0.4.3
```

Add `--global` for every project. Verify the resolved configuration with:

```text
opencode debug config
```

This confirms that OpenCode discovered the package; it does not prove that a hook blocked a tool
call. The repository's host integration performs that behavioral check against OpenCode 1.18.18
with a packed candidate and a loopback provider.

### Pi

Install globally:

```text
pi install npm:auto-mode-gate@0.4.3
```

Add `-l` for a project-local installation. Verify the package entry with:

```text
pi list
```

For source loaders, scope validation, startup checks, and safe removal, follow the
[installation guide](https://yivas.github.io/auto-mode-gate/getting-started/install/).

## Configure

Version 0.3.0 and later keep policy under the host that loads it:

| Scope | OpenCode | Pi |
|-|-|-|
| Global | `$OPENCODE_CONFIG_DIR/auto-mode-gate.json`, or `~/.config/opencode/auto-mode-gate.json` | `$PI_CODING_AGENT_DIR/auto-mode-gate.json`, or `~/.pi/agent/auto-mode-gate.json` |
| Project | `<project>/.opencode/auto-mode-gate.json` | `<project>/.pi/auto-mode-gate.json` |

A global configuration can set mode, shell, exact trusted executable paths, an optional sanitized
log path, and Pi judge authorization:

```json
{
  "mode": "enforce",
  "shell": "powershell",
  "trustedExecutablePaths": [
    "C:\\Windows\\System32\\where.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe"
  ],
  "permissionJudge": {
    "enabled": true,
    "model": {
      "provider": "example-provider",
      "id": "example-model"
    },
    "timeoutMs": 15000
  }
}
```

Project policy can only tighten the global policy. Invalid JSON, unknown keys, relative paths,
oversized input, unreadable files, and invalid host roots fail closed. Restart or reload the host
after changing configuration.

Use the documentation for the complete schema and procedures:

- [Configure host-owned policy](https://yivas.github.io/auto-mode-gate/getting-started/configure/)
- [Migrate 0.2.0 configuration without overwriting](https://yivas.github.io/auto-mode-gate/getting-started/migrate/)
- [Verify and operate the gate](https://yivas.github.io/auto-mode-gate/guide/verify-and-operate/)

## Pi controls

Introduced in 0.4.0 and unchanged in 0.4.3, `/amg-judge` opens the Pi control menu in TUI mode.
Direct commands remain available:

```text
/amg-judge status
/amg-judge on
/amg-judge off
/amg-judge model <provider> <model-id>
/amg-judge thinking <level>
/amg-judge reset
```

Requested and effective state remain separate. Project restrictions, unavailable models, missing
scope, or unsupported thinking can keep Auto inactive without erasing the user's saved choice.
These controls never change Pi's primary model or thinking level. See the
[Pi controls guide](https://yivas.github.io/auto-mode-gate/guide/pi-controls/) for preferences,
shortcuts, RPC behavior, and failure handling.

## Logs and coverage

Optional JSONL logs contain only closed enums, verdicts, effects, stable decision codes, mode, and
an in-memory repeated-rejection count. They exclude commands, arguments, prompts, context, secrets,
session IDs, call IDs, and persistent identifiers. If an `enforce` decision cannot be written to a
configured log, the tool call blocks.

Both hosts cover only calls to their built-in `bash` tool. Other tools remain under native host
permissions. Read [modes and sanitized logs](https://yivas.github.io/auto-mode-gate/guide/modes-and-logs/)
and [coverage boundaries](https://yivas.github.io/auto-mode-gate/guide/coverage-and-boundaries/)
before relying on the gate.

## Development

The package root has no installed dependencies. Run the 246 unit, runtime, integration, and shared
conformance tests with Node 24.9.0:

```text
npm test
```

The repository does not currently define a standalone TypeScript type-check command. CI runs the
same test suite, inspects package contents, builds the documentation, and starts OpenCode 1.18.18 in
isolated Linux profiles to test the packed plugin before a Bash effect. Run that host check when the
validated OpenCode binary is available:

```text
npm run test:opencode-host
```

The script exits on Windows; CI is the reproducible Linux gate, while the pinned Windows host
probe remains separate evidence. It uses temporary homes,
configuration, data, cache, state, a packed candidate, a fictional credential, and a loopback
provider with preprogrammed responses. It does not perform external model inference. CI installs the
pinned host from npm, and OpenCode may resolve its bundled plugin/provider dependencies during setup;
model traffic is restricted by configuration to the loopback endpoint. Preview package contents locally with:

```text
npm pack --dry-run
```

## License and participation

Auto Mode Gate is an **open source maintained** project distributed under the
[MIT License](https://github.com/Yivas/auto-mode-gate/blob/main/LICENSE). It accepts reproducible
bug reports and private security reports; pull requests are not currently reviewed or merged.

Read the [contribution policy](https://github.com/Yivas/auto-mode-gate/blob/main/CONTRIBUTING.md) and
[Code of Conduct](https://github.com/Yivas/auto-mode-gate/blob/main/CODE_OF_CONDUCT.md). Report bugs
through [GitHub Issues](https://github.com/Yivas/auto-mode-gate/issues) and vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).

Auto Mode Gate is independent and is not affiliated with or endorsed by OpenCode or Pi.

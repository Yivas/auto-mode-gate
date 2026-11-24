<p align="center"><img src="https://yivas.github.io/auto-mode-gate/favicon.svg" width="96" alt="Auto Mode Gate logo"></p>

<h1 align="center">Auto Mode Gate</h1>

<p align="center">Deterministic-first permission control for OpenCode and Pi.</p>

<p align="center">
  <a href="https://github.com/Yivas/auto-mode-gate/actions/workflows/ci.yml"><img src="https://github.com/Yivas/auto-mode-gate/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/auto-mode-gate"><img src="https://img.shields.io/npm/v/auto-mode-gate?label=npm" alt="npm version"></a>
  <a href="https://github.com/Yivas/auto-mode-gate/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Yivas/auto-mode-gate" alt="MIT license"></a>
</p>

[Documentation](https://yivas.github.io/auto-mode-gate/) · [Install](#install-from-npm) · [Releases](https://github.com/Yivas/auto-mode-gate/releases/latest) · [Contributing](https://github.com/Yivas/auto-mode-gate/blob/main/CONTRIBUTING.md)

> [!IMPORTANT]
> Auto Mode Gate covers only the built-in `bash` tool through validated host hooks and is not an operating-system sandbox. A separately launched child host must load its own adapter. Read the [security policy](https://github.com/Yivas/auto-mode-gate/blob/main/.github/SECURITY.md).

## What it does

Auto Mode Gate is a pre-tool gate for people running OpenCode or Pi who want deterministic checks on built-in `bash` calls before they run. It evaluates fixed rules first, blocks dangerous or ambiguous commands, and allows only narrow read-only commands that start with a configured absolute executable path.

Only eligible unresolved Git requests can reach the secondary permission judge in Pi. OpenCode has no verified isolated judge transport and blocks those eligible cases as unavailable. Deterministic denials always hold, native host permissions still apply after an allowance, and missing or malformed inputs fail closed.

## Status and version

Version `0.4.4` is published on [npm](https://www.npmjs.com/package/auto-mode-gate), [GitHub Releases](https://github.com/Yivas/auto-mode-gate/releases/tag/v0.4.4), and the [documentation site](https://yivas.github.io/auto-mode-gate/). It rebuilds the public documentation and declares the Node.js `24.9.0` baseline in the package without changing the `0.4.0` runtime.

Validated baselines:

- OpenCode `1.18.18` (`tool.execute.before`)
- Pi `0.84.2` (`tool_call`, persistent controls, and isolated judge transport)
- Node `24.9.0` (test suite)

Treat only these versions as validated baselines and check the [validated baselines reference](https://yivas.github.io/auto-mode-gate/reference/validated-baselines/) before assuming broader support.

## Decision flow

```text
action
└─ deterministic policy
   ├─ allow-final              -> continue without AI
   ├─ deny-final               -> block without AI
   ├─ unresolved-ineligible    -> block without AI
   └─ unresolved-eligible
      ├─ active Pi judge allow -> continue
      └─ deny/unavailable/fail -> block
```

Narrow read-only allowances require an exact absolute path from the global trusted-path list and matching adapter shell evidence. Bare command names, shell builtins, relative paths, unsupported syntax, and configuration errors fail closed.

Only simple literal Git `diff`, `log`, `show`, or `status` requests with a configured Git path become eligible for the judge in `enforce` mode. Pi sends one isolated request with closed enums and no command text, arguments, paths, or IDs. OpenCode blocks eligible cases as unavailable. See [how decisions work](https://yivas.github.io/auto-mode-gate/guide/decisions/).

## Install from npm

Review the package source before installing, because host plugins and extensions run with your system permissions.

### OpenCode

Declare `"auto-mode-gate@0.4.4"` in the `plugin` array of project or global `opencode.json`, or install it for the current project:

```text
opencode plugin auto-mode-gate@0.4.4
opencode debug config
```

Add `--global` for every project. `opencode debug config` confirms package discovery, not pre-tool enforcement.

### Pi

Install globally (add `-l` for a project-local install) and verify the package entry:

```text
pi install npm:auto-mode-gate@0.4.4
pi list
```

See the [installation guide](https://yivas.github.io/auto-mode-gate/getting-started/install/) for `opencode.json` examples, source loaders, and removal steps.

## Configure

OpenCode and Pi read separate host-owned JSON policy files:

| Scope | OpenCode | Pi |
|-|-|-|
| Global | `$OPENCODE_CONFIG_DIR/auto-mode-gate.json` or `~/.config/opencode/auto-mode-gate.json` | `$PI_CODING_AGENT_DIR/auto-mode-gate.json` or `~/.pi/agent/auto-mode-gate.json` |
| Project | `<project>/.opencode/auto-mode-gate.json` | `<project>/.pi/auto-mode-gate.json` |

Minimal global policy example:

```json
{
  "mode": "enforce",
  "shell": "powershell",
  "trustedExecutablePaths": [
    "C:\\Program Files\\Git\\cmd\\git.exe"
  ],
  "permissionJudge": {
    "enabled": true,
    "model": { "provider": "example-provider", "id": "example-model" },
    "timeoutMs": 15000
  }
}
```

Project policy can only tighten global policy. Invalid JSON, unknown keys, relative paths, and unreadable files fail closed. Restart or reload the host after edits. See [configure policy](https://yivas.github.io/auto-mode-gate/getting-started/configure/) and [migrate from 0.2.0](https://yivas.github.io/auto-mode-gate/getting-started/migrate/) for the full schema.

## Pi controls

In Pi TUI mode, `/amg-judge` opens the control menu. Direct commands also work in RPC mode:

```text
/amg-judge status
/amg-judge on
/amg-judge off
/amg-judge model <provider> <model-id>
/amg-judge thinking <level>
/amg-judge reset
```

These controls persist requested Auto, secondary judge model, thinking level, and shortcuts (`Ctrl+Alt+G` and `Ctrl+Alt+A` by default) in global Pi preferences without changing Pi's primary conversation model or thinking. Requested and effective state remain separate, so project restrictions, unavailable models, or missing scope disable effective Auto without erasing saved choices. Read the [Pi controls guide](https://yivas.github.io/auto-mode-gate/guide/pi-controls/).

## Logs and coverage

When global policy sets an absolute `logPath`, JSONL records include only closed enums, verdict, effect, stable decision code, mode, and an in-memory repeated-rejection count. Commands, arguments, prompts, secrets, session IDs, call IDs, and persistent identifiers are excluded. If an `enforce` decision cannot be written to the log, the call blocks.

Both adapters enforce only calls to the host's built-in `bash` tool. Other tools stay under native host permissions, and child host processes must load their own adapter. Read [modes and sanitized logs](https://yivas.github.io/auto-mode-gate/guide/modes-and-logs/) and [coverage boundaries](https://yivas.github.io/auto-mode-gate/guide/coverage-and-boundaries/).

## Development

The package root has no external dependencies. Run the 246 unit, runtime, integration, and shared conformance tests on Node `24.9.0`, or inspect the tarball contents:

```text
npm test
npm pack --dry-run
```

On Linux with OpenCode `1.18.18` installed, `npm run test:opencode-host` packs the candidate and verifies pre-tool blocking against a loopback provider without external inference (the script exits on Windows). CI runs `npm test`, `npm pack --dry-run`, the OpenCode host check, and the documentation build.

## License and participation

Auto Mode Gate is released under the MIT License. It accepts reproducible bug reports through [GitHub Issues](https://github.com/Yivas/auto-mode-gate/issues) and vulnerability reports through [GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new). Pull requests are not currently reviewed or merged. Auto Mode Gate is independent and is not affiliated with or endorsed by OpenCode or Pi.

[Changelog](https://github.com/Yivas/auto-mode-gate/blob/main/CHANGELOG.md) · [Security Policy](https://github.com/Yivas/auto-mode-gate/blob/main/.github/SECURITY.md) · [Contributing](https://github.com/Yivas/auto-mode-gate/blob/main/CONTRIBUTING.md) · [Code of Conduct](https://github.com/Yivas/auto-mode-gate/blob/main/CODE_OF_CONDUCT.md) · [MIT License](https://github.com/Yivas/auto-mode-gate/blob/main/LICENSE)

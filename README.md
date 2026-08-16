# Auto Mode Gate

Auto Mode Gate is a host-neutral permission gate for OpenCode and Pi. It applies one deterministic
policy before Bash tool calls execute. V1 blocks unknown or ambiguous actions and does not invoke a
model judge.

## Status

The core, OpenCode plugin, Pi extension, file-based configuration, sanitized JSONL logs, and
source-install flow are implemented and tested. Version 0.1.0 is prepared behind npm's `private`
publication guard; there is no published package, tag, or release. The installation commands below
load a local checkout and support only the validated baselines:

- OpenCode 1.18.18;
- Pi 0.84.1;
- Node 24.9.0 for the test suite.

## Decision flow

```text
action
└─ deterministic policy
   ├─ safe      -> continue
   ├─ dangerous -> block
   └─ ambiguous -> block
```

A narrow read-only allowance requires an exact absolute executable path present in the global
trusted-path list. Bare names, shell builtins, unsupported syntax, missing evidence, malformed
configuration, and internal errors fail closed. Native host permissions still apply after an
Auto Mode Gate allowance.

## Install from a checkout

Review the checkout before loading it. Host plugins and extensions run with the user's system
permissions.

The commands below were tested with Windows PowerShell 5.1 in isolated profiles. Set `$scope` to
`project` or `global`, run the command from the repository root, then restart the host. They create
one UTF-8 loader file and do not edit host settings. Keep the checkout at the same path while the
loader is installed.

### OpenCode

```powershell
$scope = "project"
$source = [System.Uri]::new((Resolve-Path .\src\opencode-runtime.ts).Path).AbsoluteUri
$pluginRoot = if ($scope -eq "project") {
  Join-Path (Get-Location) ".opencode\plugins"
} elseif ($env:OPENCODE_CONFIG_DIR) {
  Join-Path $env:OPENCODE_CONFIG_DIR "plugins"
} else {
  Join-Path $HOME ".config\opencode\plugins"
}
New-Item -ItemType Directory -Force $pluginRoot | Out-Null
"export { AutoModeGatePlugin } from `"$source`";" |
  Set-Content -Encoding utf8 (Join-Path $pluginRoot "auto-mode-gate.ts")
```

OpenCode loads project plugins from `.opencode/plugins/` and global plugins from its configuration
plugin directory. Verify discovery with:

```powershell
opencode debug config
```

The resolved `plugin` list must contain `auto-mode-gate.ts`.

### Pi

```powershell
$scope = "project"
$source = [System.Uri]::new((Resolve-Path .\src\pi-runtime.ts).Path).AbsoluteUri
$extensionRoot = if ($scope -eq "project") {
  Join-Path (Get-Location) ".pi\extensions\auto-mode-gate"
} elseif ($env:PI_CODING_AGENT_DIR) {
  Join-Path $env:PI_CODING_AGENT_DIR "extensions\auto-mode-gate"
} else {
  Join-Path $HOME ".pi\agent\extensions\auto-mode-gate"
}
New-Item -ItemType Directory -Force $extensionRoot | Out-Null
"export { default } from `"$source`";" |
  Set-Content -Encoding utf8 (Join-Path $extensionRoot "index.ts")
```

Pi loads project extensions only after the project is trusted. A startup-only check that does not
contact model providers is:

```powershell
pi --offline --list-models
```

Pi 0.84.1 does not list auto-discovered extension files in `pi list`; that command lists installed
packages from settings.

## Configure

Auto Mode Gate reads one global file and, when present, `.auto-mode-gate.json` from the project
root. It reads configuration when each host adapter starts; restart or reload the host after a
change.

Global path resolution:

1. `$XDG_CONFIG_HOME/auto-mode-gate/config.json` when `XDG_CONFIG_HOME` is set;
2. `%APPDATA%\auto-mode-gate\config.json` on Windows;
3. `~/.config/auto-mode-gate/config.json` elsewhere.

Configured roots and every file path must be absolute for the current operating system. Relative
`XDG_CONFIG_HOME` or `APPDATA` values fail closed.

Example global configuration:

```json
{
  "mode": "enforce",
  "shell": "powershell",
  "trustedExecutablePaths": [
    "C:\\Windows\\System32\\where.exe"
  ],
  "logPath": "C:\\Users\\example\\logs\\auto-mode-gate.jsonl"
}
```

Create the log directory before starting the host. The supported global keys are:

| Key | Values | Meaning |
|-|-|-|
| `mode` | `off`, `shadow`, `enforce` | Defaults to `enforce` |
| `shell` | `bash`, `powershell`, `cmd` | Required before a Bash tool call can be allowed |
| `trustedExecutablePaths` | Absolute path array | Exact global authority for narrow read-only allowances |
| `logPath` | Absolute file path | Optional sanitized JSONL decision log |

Project configuration accepts only `mode` and `trustedExecutablePaths`:

```json
{
  "mode": "enforce",
  "trustedExecutablePaths": [
    "C:\\Windows\\System32\\where.exe"
  ]
}
```

Project configuration may tighten `shadow` to `enforce` and remove trusted paths. It cannot enable
a globally `off` gate, relax `enforce`, set the shell, add trust absent from the global file, or set
a log path. Unknown keys, invalid JSON, relative paths, and unreadable files fail closed.

Modes behave as follows:

- `enforce`: denied actions block;
- `shadow`: policy and logs run, but actions do not block;
- `off`: the adapter remains loaded but does not block.

`shadow` is an observation mode, not a security control.

## Logs

Each JSONL record contains only:

- host, tool, and shell enums;
- policy verdict, final effect, and stable decision code;
- deterministic source, mode, and blocked state;
- an in-memory repeated-rejection count.

Logs exclude commands, arguments, prompts, context, secrets, session IDs, call IDs, and persistent
identifiers. If an `enforce` decision cannot be written to the configured log file, the tool call
blocks with `AMG_DENY_INTERNAL_ERROR`. Logging is disabled when `logPath` is absent.

## Operation

OpenCode and Pi activate independently through their loader files. Removing one loader leaves the
other host unchanged. Auto Mode Gate adds no status, enable, disable, or configuration command;
those controls remain file-based because neither shared host contract requires another command.

Both hosts enforce only calls to their built-in `bash` tool. Other tools remain under native host
permissions. A child process must load its own adapter. See
[`docs/compatibility.md`](docs/compatibility.md) for parity and coverage limits.

## Remove

Delete only the loader created during installation, then restart the host.

OpenCode:

```powershell
Remove-Item <plugin-root>\auto-mode-gate.ts
```

Pi:

```powershell
Remove-Item -Recurse <extension-root>\auto-mode-gate
```

These commands do not edit host settings or remove `.auto-mode-gate.json`, the global Auto Mode
Gate configuration, logs, or the source checkout. Remove those separately only when they are no
longer needed.

## Development

The repository has no installed dependencies. Run unit, runtime, integration, and shared
conformance tests with:

```text
npm test
```

The strict TypeScript check and clean-profile commands used for the validated baseline are recorded
in the private project evidence. No broader Node or host compatibility is claimed.

## Upstream and license

The design study uses OpenCode Swarm at commit
[`50033bc1e0a0d943433701042fed90b2a791f7fe`](https://github.com/ZaxbyHub/opencode-swarm/commit/50033bc1e0a0d943433701042fed90b2a791f7fe)
as a reference. OpenCode Swarm is MIT licensed. This repository is an independent implementation
and excludes Swarm's orchestration system.

See [`docs/upstream.md`](docs/upstream.md), [`NOTICE`](NOTICE), and [`LICENSE`](LICENSE).

## Participation

Intended mode: open-source maintained under MIT. This local repository has no public remote, issue
tracker, contribution channel, or security contact. Pull requests are not accepted during the
pre-publication phase.

Auto Mode Gate is independent and is not affiliated with Anthropic, OpenCode, Pi, or OpenCode
Swarm.

# Auto Mode Gate

Auto Mode Gate is a host-neutral permission gate for OpenCode and Pi. It applies one deterministic
policy before Bash tool calls execute. V1 blocks unknown or ambiguous actions and does not invoke a
model judge.

## Status

The core, OpenCode plugin, Pi extension, file-based configuration, sanitized JSONL logs, and
installation flows are implemented and tested. Version 0.1.0 is published on
[npm](https://www.npmjs.com/package/auto-mode-gate) and
[GitHub](https://github.com/Yivas/auto-mode-gate/releases/tag/v0.1.0). It supports only the
validated baselines:

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

## Install from npm

Review the package source before installing it. Host plugins and extensions run with the user's
system permissions.

### OpenCode

Install for the current project:

```text
opencode plugin auto-mode-gate@0.1.0
```

Add `--global` to install it for every project. Verify the resolved `plugin` list:

```text
opencode debug config
```

### Pi

Install globally:

```text
pi install npm:auto-mode-gate@0.1.0
```

Add `-l` for a project-local installation. Verify the package entry:

```text
pi list
```

## Install from a checkout

Review the checkout before loading it. Host plugins and extensions run with the user's system
permissions.

The global loader flow was tested with Windows PowerShell 5.1 in isolated host profiles. The
project-scope path handling was checked against a separate temporary project without starting the
hosts. Run the commands from the checkout root. Set `$scope` to `project` or `global`; for project
scope, set `$targetProject` to the project that should load the gate. Then restart the host. The
commands create one UTF-8 loader file and do not edit host settings. Keep the checkout at the same
path while the loader is installed.

### OpenCode

```powershell
$scope = "project"
$targetProject = "C:\path\to\project"
$source = [System.Uri]::new((Resolve-Path .\src\opencode-runtime.ts).Path).AbsoluteUri
$pluginRoot = if ($scope -eq "project") {
  Join-Path (Resolve-Path $targetProject).Path ".opencode\plugins"
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
if ($scope -eq "project") {
  Push-Location $targetProject
  try { opencode debug config } finally { Pop-Location }
} else {
  opencode debug config
}
```

The resolved `plugin` list must contain `auto-mode-gate.ts`.

### Pi

```powershell
$scope = "project"
$targetProject = "C:\path\to\project"
$source = [System.Uri]::new((Resolve-Path .\src\pi-runtime.ts).Path).AbsoluteUri
$extensionRoot = if ($scope -eq "project") {
  Join-Path (Resolve-Path $targetProject).Path ".pi\extensions\auto-mode-gate"
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
if ($scope -eq "project") {
  Push-Location $targetProject
  try { pi --offline --list-models } finally { Pop-Location }
} else {
  pi --offline --list-models
}
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

OpenCode and Pi activate independently through their package entries or source loader files.
Removing one installation leaves the other host unchanged. Auto Mode Gate adds no status, enable,
disable, or configuration command; those controls remain host- and file-based because neither
shared host contract requires another command.

Both hosts enforce only calls to their built-in `bash` tool. Other tools remain under native host
permissions. A child process must load its own adapter. See
[`docs/compatibility.md`](docs/compatibility.md) for parity and coverage limits.

## Remove

For an npm installation, remove `auto-mode-gate@0.1.0` from OpenCode's `plugin` list. OpenCode
1.18.18 has no plugin removal subcommand. Remove the Pi package with the same scope used to install
it:

```text
pi remove npm:auto-mode-gate
pi remove npm:auto-mode-gate -l
```

For a source installation, delete only its loader, then restart the host:

```powershell
Remove-Item <plugin-root>\auto-mode-gate.ts
Remove-Item -Recurse <extension-root>\auto-mode-gate
```

Removal does not delete `.auto-mode-gate.json`, the global Auto Mode Gate configuration, logs, or
a source checkout. Remove those separately only when they are no longer needed.

## Development

The repository has no installed dependencies. Run unit, runtime, integration, and shared
conformance tests with:

```text
npm test
```

The strict TypeScript check requires external compiler and Node type-definition paths; the exact
versions, flags, and command used for the validated baseline are recorded in the private project
evidence. No broader Node or host compatibility is claimed.

## Upstream and license

The design study uses OpenCode Swarm at commit
[`50033bc1e0a0d943433701042fed90b2a791f7fe`](https://github.com/ZaxbyHub/opencode-swarm/commit/50033bc1e0a0d943433701042fed90b2a791f7fe)
as a reference. OpenCode Swarm is MIT licensed. This repository is an independent implementation
and excludes Swarm's orchestration system.

See [`docs/upstream.md`](docs/upstream.md), [`NOTICE`](NOTICE), and [`LICENSE`](LICENSE).

## Participation

Auto Mode Gate is maintained under MIT. Report reproducible bugs through
[GitHub Issues](https://github.com/Yivas/auto-mode-gate/issues). Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).
Pull requests are not currently accepted.

Auto Mode Gate is independent and is not affiliated with Anthropic, OpenCode, Pi, or OpenCode
Swarm.

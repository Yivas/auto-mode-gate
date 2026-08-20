# Auto Mode Gate

Auto Mode Gate is a host-neutral permission gate for OpenCode and Pi. It applies deterministic
policy before Bash tool calls execute. Version 0.3.0 keeps global and project policy under each
host, with migration from the shared `0.2.0` paths. Current source adds global Pi preferences for
Auto, the judge model, and thinking without changing the primary conversation model. Version 0.1.0
remains the deterministic-only release.

## Status

The core, OpenCode plugin, Pi extension, file-based configuration, sanitized JSONL logs, and
installation flows are implemented and tested. Version 0.3.0 separates policy by host and migrates
valid shared configuration without overwriting or deleting it. The unreleased Pi controls persist
preferences in the Pi configuration root and restore them for new sessions. Version 0.3.0 is
published on [npm](https://www.npmjs.com/package/auto-mode-gate) and
[GitHub](https://github.com/Yivas/auto-mode-gate/releases/tag/v0.3.0). Read the
[public documentation](https://yivas.github.io/auto-mode-gate/) for the guided installation and
configuration reference. It supports only the validated baselines:

- OpenCode 1.18.18;
- Pi 0.84.1 for the published deterministic adapter;
- Pi 0.84.2 for the researched and isolated judge transport;
- Node 24.9.0 for the test suite.

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
Auto Mode Gate allowance.

Deterministic allowances, denials, ineligible input, `off`, and `shadow` skip AI calls. In
`enforce`, only an eligible Git `diff`, `log`, `show`, or `status` candidate can reach the
user-selected Pi model. Errors, cancellation, timeout, invalid output, tool-call output, missing
model, inactive session, and missing transport block. A model decision never overrides a
deterministic denial. After an enforced allowance, the adapter freezes the host argument object so
a later pre-tool handler cannot replace the reviewed command before execution.

## Install from npm

Review the package source before installing it. Host plugins and extensions run with the user's
system permissions.

### OpenCode

The recommended setup is to declare the package in the `plugin` array of your project or global
`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["auto-mode-gate@0.3.0"]
}
```

Merge that entry into an existing `plugin` array without removing other plugins or configuration.
OpenCode resolves configured npm plugins when it starts.

Alternatively, install it for the current project:

```text
opencode plugin auto-mode-gate@0.3.0
```

Add `--global` to install it for every project.

Verify the resolved `plugin` list:

```text
opencode debug config
```

### Pi

Install globally:

```text
pi install npm:auto-mode-gate@0.3.0
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

Version `0.3.0` keeps policy under the host that loads it. Auto Mode Gate reads configuration when
an adapter starts; restart or reload that host after a change.

| Scope | OpenCode | Pi |
|-|-|-|
| Global | `$OPENCODE_CONFIG_DIR/auto-mode-gate.json`, or `~/.config/opencode/auto-mode-gate.json` | `$PI_CODING_AGENT_DIR/auto-mode-gate.json`, or `~/.pi/agent/auto-mode-gate.json` |
| Project | `<project>/.opencode/auto-mode-gate.json` | `<project>/.pi/auto-mode-gate.json` |

A non-empty host root environment variable must contain an absolute path to an existing regular
directory. Relative roots, symlinks, and non-directory roots fail closed.

When a host-owned destination is absent, the adapter checks the `0.2.0` paths as migration sources:
`$XDG_CONFIG_HOME/auto-mode-gate/config.json`, `%APPDATA%\auto-mode-gate\config.json` on Windows,
`~/.config/auto-mode-gate/config.json`, and `<project>/.auto-mode-gate.json`. A valid source is
copied byte for byte with exclusive publication. Migration never replaces a destination or deletes
the source. Once a destination exists, it is authoritative and legacy is ignored. See the
[migration guide](https://yivas.github.io/auto-mode-gate/getting-started/migrate/).

The `permissionJudge` keys below require version `0.2.0` or later. Example global configuration:

```json
{
  "mode": "enforce",
  "shell": "powershell",
  "trustedExecutablePaths": [
    "C:\\Windows\\System32\\where.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe"
  ],
  "logPath": "C:\\Users\\example\\logs\\auto-mode-gate.jsonl",
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

Create the log directory before starting the host. The supported global keys are:

| Key | Values | Meaning |
|-|-|-|
| `mode` | `off`, `shadow`, `enforce` | Defaults to `enforce` |
| `shell` | `bash`, `powershell`, `cmd` | Required before a Bash tool call can be allowed |
| `trustedExecutablePaths` | Absolute path array | Exact global authority for narrow read-only allowances |
| `logPath` | Absolute file path | Optional sanitized JSONL decision log |
| `permissionJudge` | Strict object | Global opt-in, default Pi model, and 1,000–120,000 ms timeout |

Project configuration accepts `mode`, `trustedExecutablePaths`, and judge tightening:

```json
{
  "mode": "enforce",
  "trustedExecutablePaths": [
    "C:\\Windows\\System32\\where.exe"
  ],
  "permissionJudge": {
    "enabled": false
  }
}
```

Project configuration may tighten `shadow` to `enforce`, remove trusted paths, disable the judge,
or reduce its timeout. It cannot enable a globally `off` gate, relax `enforce`, set the shell, add
trust absent from the global file, set a log path, authorize the judge, change its model, or increase
its timeout. Each configuration file may contain at most 64 KiB, and each trusted-path list may
contain at most 256 entries. Unknown keys, invalid JSON, relative paths, oversized input, and
unreadable files fail closed.

Modes behave as follows:

- `enforce`: denied actions block;
- `shadow`: policy and logs run, but actions do not block;
- `off`: the adapter remains loaded but does not block.

`shadow` is an observation mode, not a security control.

### Pi judge preferences in current source

Pi stores user choices in `$PI_CODING_AGENT_DIR/auto-mode-gate-preferences.json` or
`~/.pi/agent/auto-mode-gate-preferences.json`. This file does not authorize the judge and has no
project variant. Global authorization and a project `permissionJudge.enabled: false` setting still
win.

```json
{
  "version": 1,
  "autoEnabled": true,
  "model": {
    "provider": "example-provider",
    "id": "example-model"
  },
  "thinking": "high",
  "shortcuts": {
    "menu": "ctrl+alt+g",
    "toggleAuto": "ctrl+alt+a"
  }
}
```

`model` and `thinking` are optional overrides. Omitting them uses the authorized model and
`inherit`. Thinking accepts `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`,
but a model can support fewer levels. Invalid JSON, extra keys, oversized input, links, unreadable
files, unavailable models, missing model scope, and unsupported thinking fail safely. A failed save
leaves the current session unchanged. Changing shortcut values requires `/reload` or a restart.

The defaults are `Ctrl+Alt+G` for the control menu and `Ctrl+Alt+A` for the quick Auto toggle. Pi
may warn if another extension registers the same combination.

## Logs

Each JSONL record contains only:

- host, tool, and shell enums;
- policy verdict, final effect, and stable decision code;
- deterministic or judge source, mode, and blocked state;
- an in-memory repeated-rejection count.

Logs exclude commands, arguments, prompts, context, secrets, session IDs, call IDs, and persistent
identifiers. If an `enforce` decision cannot be written to the configured log file, the tool call
blocks with `AMG_DENY_INTERNAL_ERROR`. Logging is disabled when `logPath` is absent.

## Operation

OpenCode and Pi activate independently through their package entries or source loader files.
Removing one installation leaves the other host unchanged. In current source, `/amg-judge` opens
the Pi control menu in TUI mode. Direct commands remain available:

```text
/amg-judge status
/amg-judge on
/amg-judge off
/amg-judge model <provider> <model-id>
/amg-judge thinking <level>
/amg-judge reset
```

RPC executes direct commands and emits notifications. Print and JSON modes do not open or wait for
UI. Auto, model, and thinking changes are written before the current session adopts them. `reset`
restores the authorized model and `inherit` while preserving Auto and shortcuts. These controls do
not change Pi's primary model, primary thinking level, settings, or session JSONL. OpenCode has no
judge command or model transport and blocks eligible cases as unavailable.

Both hosts enforce only calls to their built-in `bash` tool. Other tools remain under native host
permissions. A child process must load its own adapter. See
[`docs/compatibility.md`](docs/compatibility.md) for parity and coverage limits.

## Remove

OpenCode 1.18.18 has no plugin removal subcommand. For an npm installation:

1. Run `opencode debug config`.
2. Find the `auto-mode-gate` item in `plugin_origins` and note its `source` directory.
3. Open `opencode.json` in that directory and remove only the matching item from `plugin`.
4. Restart OpenCode and confirm that `opencode debug config` no longer lists it.

Remove the Pi package with the same scope used to install it:

```text
pi remove npm:auto-mode-gate
pi remove npm:auto-mode-gate -l
```

For a source installation, delete only its loader, then restart the host:

```powershell
Remove-Item <plugin-root>\auto-mode-gate.ts
Remove-Item -Recurse <extension-root>\auto-mode-gate
```

Removal does not delete host-owned or legacy Auto Mode Gate configuration, logs, or a source
checkout. Remove those separately only after verifying both hosts and any required rollback path.

## Development

The repository has no installed dependencies. Run unit, runtime, integration, and shared
conformance tests with:

```text
npm test
```

The strict TypeScript check requires external compiler and Node type-definition paths; the exact
versions, flags, and command used for the validated baseline are recorded in the private project
evidence. No broader Node or host compatibility is claimed.

`npm pack --dry-run` previews package contents without creating a tarball. Release artifacts must be
built from the tagged release commit and inspected before publication.

## License

Auto Mode Gate is distributed under the [MIT License](LICENSE).

## Participation

Auto Mode Gate is maintained under MIT. Read the [contribution policy](CONTRIBUTING.md) and
[Code of Conduct](CODE_OF_CONDUCT.md) before participating. Report reproducible bugs through
[GitHub Issues](https://github.com/Yivas/auto-mode-gate/issues). Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).
Pull requests are not currently accepted.

Auto Mode Gate is an independent project and is not affiliated with or endorsed by OpenCode or Pi.

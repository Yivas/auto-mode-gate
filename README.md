# Auto Mode Gate

Auto Mode Gate is a host-neutral permission gate for OpenCode and Pi. It applies deterministic
policy before Bash tool calls execute. Version 0.2.0 adds an opt-in Pi judge after deterministic
analysis and sends only a closed sanitized request for an eligible unresolved Git action. Version
0.1.0 remains the deterministic-only release.

## Status

The core, OpenCode plugin, Pi extension, file-based configuration, sanitized JSONL logs, and
installation flows are implemented and tested. Version 0.2.0 includes session-scoped Pi judge
controls and transport. It is published on
[npm](https://www.npmjs.com/package/auto-mode-gate) and
[GitHub](https://github.com/Yivas/auto-mode-gate/releases/tag/v0.2.0). Read the
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
  "plugin": ["auto-mode-gate@0.2.0"]
}
```

Merge that entry into an existing `plugin` array without removing other plugins or configuration.
OpenCode resolves configured npm plugins when it starts.

Alternatively, install it for the current project:

```text
opencode plugin auto-mode-gate@0.2.0
```

Add `--global` to install it for every project.

Verify the resolved `plugin` list:

```text
opencode debug config
```

### Pi

Install globally:

```text
pi install npm:auto-mode-gate@0.2.0
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
Removing one installation leaves the other host unchanged. In Pi, `/amg-judge status`, `on`, `off`,
`model <provider> <model-id>`, and `reset` control only the current in-memory session. Every session
starts off. These commands do not change Pi's primary model, settings, or session JSONL. OpenCode
has no judge command or model transport and blocks eligible cases as unavailable.

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

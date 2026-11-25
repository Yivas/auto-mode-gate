# Security Policy

## Supported versions

Only the latest published Auto Mode Gate version receives security fixes. Security support covers
both runtime adapters at their validated host baselines.

| Component | Supported baseline |
|-|-|
| Auto Mode Gate | 0.4.x |
| OpenCode adapter | OpenCode 1.18.18 |
| Pi adapter | Pi 0.84.2 |

OpenCode 2.x is not supported yet: it does not load this plugin, so the gate gives no protection
there. The [compatibility baseline](../docs/compatibility.md#opencode-2x) shows the source evidence,
which comes from the pinned `v2.4.1` source and not from a runtime trace.

Review the [compatibility baseline](../docs/compatibility.md) before reporting behavior outside the
supported hook paths or host versions. Auto Mode Gate is a pre-tool policy gate, not an
operating-system sandbox.

## Outside the security model

These limits are observable in the code and the tests, and they are not vulnerabilities:

- Only the host's built-in `bash` tool is evaluated. Every other tool, and any command that does
  not pass through the documented pre-tool hook, remains under native host permissions.
- A separately launched child host process must load its own adapter. The parent host's gate does
  not extend to it, and Pi exposes no native subagent identity to cover it.
- The trusted executable path list is configuration authority, not an immutable file handle. A
  local attacker who can replace a trusted executable, or replace a parent directory in its path
  before execution, defeats the allowance.

The [compatibility baseline](../docs/compatibility.md) records these and the remaining known
limits under "Known limits".

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).
Private vulnerability reporting is enabled for this repository. Do not open a public issue for an
undisclosed vulnerability.

Include:

- the affected Auto Mode Gate version;
- the host and host version;
- the operating system;
- the smallest sanitized reproduction you can provide;
- the expected and observed behavior;
- the security impact and any known workaround.

Remove credentials, tokens, prompts, identifiers, active configuration values, and other private
data. Redact private values inside commands, logs, and paths instead of removing the technical
detail needed to reproduce the problem.

## What happens after a report

The maintainer will review the report, reproduce it when possible, and may ask for more sanitized
evidence. If the report is valid, the maintainer will coordinate a fix and public disclosure through
the private advisory. Do not disclose the vulnerability publicly before that coordination is
complete.

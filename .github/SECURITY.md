# Security Policy

## Supported versions

Only the latest published version receives security fixes. Security support covers both runtime
adapters at their validated host baselines.

| Component | Supported baseline |
|-|-|
| Auto Mode Gate | 0.1.x |
| OpenCode adapter | OpenCode 1.18.18 |
| Pi adapter | Pi 0.84.1 |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected version, host and operating system, reproduction steps, expected behavior, and
observed behavior. Remove credentials, prompts, commands, logs, paths, and other private data before
submitting evidence.

Auto Mode Gate is a pre-tool policy gate, not an operating-system sandbox. Review the documented
limits in [`docs/compatibility.md`][compatibility] before reporting behavior that falls outside the
supported hook paths or host baselines.

[compatibility]: https://github.com/Yivas/auto-mode-gate/blob/main/docs/compatibility.md

# Security Policy

## Supported versions

Only the latest published version receives security fixes.

| Version | Supported |
|-|-|
| 0.1.x | Yes |

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

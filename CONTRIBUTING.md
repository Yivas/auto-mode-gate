# Contributing

Auto Mode Gate currently accepts reproducible bug reports and private security reports. Pull
requests are not accepted.

## Before reporting a bug

1. Check the [supported versions and host baselines](docs/compatibility.md).
2. Search existing issues for the same behavior.
3. Confirm that the problem occurs on a supported Auto Mode Gate and host version.
4. Remove private data from every example and attachment.

Use the [bug report form](https://github.com/Yivas/auto-mode-gate/issues/new/choose) and include:

- the Auto Mode Gate version;
- OpenCode or Pi and its version;
- the operating system;
- the smallest sanitized reproduction;
- the expected and observed behavior.

Remove credentials, tokens, prompts, identifiers, active configuration values, and other private
data. Redact private values inside commands, logs, and paths instead of removing the technical
detail needed to reproduce the defect.

## Security reports

Do not report undisclosed vulnerabilities in a public issue. Follow the
[security policy](.github/SECURITY.md) and use
[GitHub private vulnerability reporting](https://github.com/Yivas/auto-mode-gate/security/advisories/new).

## Pull requests

Pull requests are not reviewed or merged at this time. If a reproducible defect needs a code
change, report the defect through the bug form. This policy may change in a future release; the
README and this file will be updated first.

All project interactions must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

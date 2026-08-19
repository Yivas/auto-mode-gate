# Changelog

## Unreleased

- Move global and project policy files under the OpenCode or Pi configuration root.
- Migrate valid legacy configuration by an exclusive byte-for-byte copy without overwriting a host-owned destination or deleting the source.
- Fail closed for invalid files, relative host roots, symlinks, non-regular entries, and migration errors.

## 0.2.0 - 2026-08-17

- Add an opt-in, session-scoped Pi permission judge for sanitized eligible Git actions.
- Add monotonic global/project judge configuration, model selection, local deadlines, cancellation, and strict fail-closed output validation.
- Keep OpenCode judge-eligible actions blocked as unavailable until a public isolated transport is verified.
- Fail closed when OpenCode or Pi omits the project directory required for project configuration.
- Bound Pi's per-project adapter cache and file-based configuration input.
- Repair wiki navigation and check internal documentation links before each build.
- Freeze argument objects after enforced allowances so later pre-tool handlers cannot replace the reviewed command.
- Reject malformed or oversized Pi completion shapes and recheck the local deadline after response parsing.
- Fail closed for explicitly unauthorized adapter judges and asynchronous decision callbacks.

## 0.1.0 - 2026-08-16

- Add the deterministic host-neutral permission core.
- Add fail-closed OpenCode and Pi runtime adapters.
- Add strict global and project configuration with non-relaxing precedence.
- Add optional sanitized JSONL decision logs.
- Add source installation and removal instructions for the validated host baselines.

This is the first public release.

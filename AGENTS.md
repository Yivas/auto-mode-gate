# AGENTS.md

This repository contains only material intended for the public Auto Mode Gate project. All code,
identifiers, comments, tests, fixtures, documentation, issues, pull requests, releases, branches,
and commits must be written in English.

## Status and scope

The repository contains the host-neutral permission core, OpenCode and Pi runtime adapters, strict
file-based configuration, npm and source-install documentation, and tests. Version 0.1.0 is the
first public release on GitHub and npm.

The product uses the shared core through separate OpenCode and Pi adapters. It must not contain
multi-agent orchestration, private planning, local profiles, prompts, objectives, credentials,
sessions, real logs, or operational configuration values. Generic schemas, sanitized log formats,
documentation, and fictional examples are allowed.

## Rules

- Make the smallest correct change and prefer language, host, and standard-library APIs over new
  dependencies.
- Read every file completely before editing it.
- Do not invent host APIs, package names, commands, settings, model defaults, or compatibility.
- Pin and verify public host contracts before implementing an adapter.
- Apply deterministic rules before the model judge. A deterministic denial cannot be overridden.
- Fail closed on unknown input, missing evidence, parse failure, timeout, invalid judge output, or
  internal error.
- Do not infer agent or subagent identity when the host does not provide it.
- Do not add telemetry, analytics, phone-home behavior, secrets, real endpoints, or correlatable
  identifiers.
- Do not modify user installations or global OpenCode/Pi configuration during tests. Use isolated
  temporary profiles after explicit approval.
- Run the repository's formatter, type checker, tests, package inspection, and code review after
  executable changes.

## Third-party code

Before copying or adapting third-party code, record its source file, symbol, revision, and license.
Confirm transitive dependencies and retain every notice required by the source license.

Do not port multi-agent orchestration, agent roles, planning phases, shared memory, QA coordination,
worktrees, councils, or orchestration state.

## Git

Work on the current branch. Do not create branches, remotes, tags, or releases unless requested.
Before committing, inspect `git status`, `git diff`, and recent history. Commit only public files
with English messages and no AI metadata.

# Changelog

All notable changes to `create-moss-app` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Generated projects now depend only on `@rdk-moss/agent`; the agent package owns its compatible `@rdk-moss/core` range, so scaffolding cannot independently select a mismatched core release.
- Core, agent, and `create-moss-app` are preflighted and staged as one release set before their `latest` tags are promoted.

### Fixed

- Prerelease CLI tarballs now scaffold the matching prerelease `@rdk-moss/agent` set instead of resolving npm's stable `latest` tag.
- Generated MCP examples close every connection in a `finally` block, so enabled stdio servers do not keep the starter process alive or leak child processes after chat failures.
- Windows now resolves the npm command shim when querying published Moss versions, so generated projects no longer silently fall back to stale dependency ranges.

## [0.1.3] - 2026-06-08

### Fixed

- Updated the fallback generated Moss dependency range to `^0.3.16`.
- Added release and hygiene checks so scaffold dependency ranges stay aligned
  with the published Moss workspace version.

## [0.1.2] - 2026-06-08

### Fixed

- Generated project dependencies now follow the installed `@rdk-moss/core` and
  `@rdk-moss/agent` versions when available, falling back to the current
  `^0.3.15` range. This keeps consumer smoke tests and local scaffolds from
  drifting behind newly published Moss packages.

## [0.1.1] - 2026-05-17

### Changed

- Generated projects now depend on the current Moss package ranges:
  `@rdk-moss/core@^0.3.2` and `@rdk-moss/agent@^0.3.6`.
- Scaffold version ranges are verified by `publish:moss:lint` and the consumer
  smoke.

## [0.1.0] - 2026-04-14

### Added

- Initial `minimal` and `openai` project templates for standalone Moss agents.

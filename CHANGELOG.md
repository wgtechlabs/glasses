# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- enable build-flow on all branches (#7)

## [0.1.0] - 2026-07-10

### Added

- add funding configuration
- add telegram webhook channel and gateway http server
- add pluggable agent contract with copilot cli wrapper and devin skeleton
- add railway sandbox manager for remote agent execution
- add postgres schema and client for conversations, messages, and jobs

### Changed

- add code of conduct
- update README for clarity and reformat inspiration section
- add project technology badges
- restore GitHub repository banner
- address code review feedback
- update banner and clarify setup instructions
- correct runtime description in architecture doc
- add build flow action for ci and docker hub/ghcr publishing
- relicense as gpl-3.0-or-later and update readme for node runtime
- align stack with devin-discord-bot (node runtime, pg, log-engine, biome)
- add readme and architecture documentation
- add docker and railway deployment configuration
- initialize glasses project scaffold with config and types

### Security

- add security policy documentation
- remove unused npm from runtime image


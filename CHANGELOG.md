# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-24

### Added

- Salda Smarty heat recovery ventilation over local Modbus TCP: supply,
  extract and outdoor temperatures, mode, current mode, unit state, fan
  speeds, filter days left, alarm, warning and boost.
- Commands behind "Allow the commands" (off by default): the mode (building
  protection, economy, comfort) and "Start the boost", refused on a unit in
  stand-by, stopping (cooling the heaters, closing the dampers), or in
  critical or fire alarm, and when the unit's versions changed; "Stop the
  boost" never depends on the option (the guide lists when it can fail).
- "Test the connection" button, docs in English and French, cover image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-salda-smarty/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-salda-smarty/releases/tag/v0.1.1

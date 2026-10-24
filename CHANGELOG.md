# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Salda Smarty heat recovery ventilation over local Modbus TCP: supply,
  extract and outdoor temperatures, mode, current mode, unit state, fan
  speeds, filter days left, alarm, warning and boost.
- Commands behind "Allow the commands" (off by default): the mode (building
  protection, economy, comfort) and "Start the boost", refused on a unit in
  stand-by or in alarm; "Stop the boost" always allowed.
- "Test the connection" button, docs in English and French, cover image.

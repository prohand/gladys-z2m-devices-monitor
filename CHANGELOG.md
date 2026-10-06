# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).
- mqtt updated to 5.16.

## [2.0.0] - 2026-09-22

### Added

- Add the Gladys 5.1 dashboard widget, scene triggers and scene actions

## [1.0.5] - 2026-08-25

### Changed

- Accept a broker URL typed without its mqtt:// scheme

### Removed

- Drop the troubleshooting entry and the port reminder

## [1.0.4] - 2026-08-15

### Changed

- Declare store catalog categories and upgrade the SDK to 0.12.0 (Gladys 4.86)

### Removed

- Drop the protocols category, keep network alone

## [1.0.3] - 2026-08-12

### Changed

- Add the missing "Get device value" step to the alert scene

## [1.0.2] - 2026-08-12

### Fixed

- Draw the Alive feature on a released Gladys, not just on master
- Keep the manifest Prettier-formatted across releases

## [1.0.1] - 2026-08-12

First public release.

### Added

- Z2M Devices Monitor, a Gladys integration watching Zigbee2MQTT liveness

### Changed

- Add CLAUDE.md

### Fixed

- Publish min/max on every feature, the Discovery screen rejected them
- Send text states in their own field, and suffix the device names
- Give a device its value the moment the user creates it
- Say what the monitor really shows, and stop duplicating the LQI

[Unreleased]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.5...v2.0.0
[1.0.5]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-z2m-devices-monitor/releases/tag/v1.0.1

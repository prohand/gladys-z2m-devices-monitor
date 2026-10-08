# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

## [2.2.1] - 2026-10-08

### Added

- TLS settings for `mqtts://` / `wss://` brokers: a CA certificate (PEM, pasting it on one line works) and a switch to turn the certificate verification off.

### Changed

- After an outage (broker unreachable, bridge offline, integration stopped) longer than a threshold, a device that was alive when it began gets one threshold from the end of the outage to speak again, instead of being announced silent then back.
- State publishing keeps under the host API budget (250 states per sliding minute, alerts first), retries once after a 429, and spreads the 30-minute refresh of unchanged values.
- Zigbee2MQTT groups are no longer buffered as unknown devices; activity of names never resolved expires after an hour.
- The base image is pinned by digest and `/data` is owned by the `node` user in the image.

### Fixed

- A transient host API failure right after a Gladys reconnection no longer leaves the integration without its watchdog.
- Publications triggered at the same time (tick, reconnection, buttons) no longer interleave.
- The history is saved to `/data` during a Gladys outage too, and two overlapping saves no longer share a temporary file.
- A bare empty `bridge/devices` payload no longer wipes the device list and its history.
- Credentials written into the broker URL are masked in the logs, the status and the button answers.

## [2.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [2.1.0] - 2026-10-06

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

[Unreleased]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.5...v2.0.0
[1.0.5]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-z2m-devices-monitor/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-z2m-devices-monitor/releases/tag/v1.0.1

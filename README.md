# Z2M Devices Monitor — a Gladys Assistant integration

Watches your [Zigbee2MQTT](https://www.zigbee2mqtt.io/) devices and tells you
when one of them **stops giving signs of life**.

Built on the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> User documentation: [English](docs/en.md) · [Français](docs/fr.md)

## Why

The battery level of a Zigbee device cannot tell you that it died. It is a
coarse, rarely refreshed and often plainly wrong estimate — a CR2032 sensor
commonly reads 100% right up to the day it stops answering — and it says nothing
about the other ways a device dies: unplugged, dropped off the network, route
lost, parent router down.

A Zigbee device that is alive **talks**. So the only reliable fact is _when did I
last hear from this device?_, and the only useful question is _has it been silent
for longer than it should?_

## How it works

The integration subscribes to `<base_topic>/#` on the MQTT broker Zigbee2MQTT
publishes on, reads the device inventory from `<base_topic>/bridge/devices`, and
records when each device last spoke. It publishes nothing to your Zigbee network:
it only listens.

The whole subtlety is deciding what actually counts as a sign of life — see
[`src/messageRouter.js`](src/messageRouter.js):

| Message                                                    | Sign of life?                     |
| ---------------------------------------------------------- | --------------------------------- |
| A report published **by** the device                       | ✅ it just spoke                  |
| The same report **replayed by the broker** (retained flag) | ❌ it may be days old             |
| A report carrying its own `last_seen`                      | ✅ and we know exactly when       |
| A `set` / `get` command sent **to** the device             | ❌ that is us talking             |
| A `device_announce` bridge event                           | ✅ it just (re)joined the network |

The retained case is the one that matters most: on every reconnection a broker
replays the last message of every device. Counting those as fresh would reset the
whole network to "seen just now", including the sensor that died last week — the
exact lie this integration exists to prevent.

## What it publishes to Gladys

One Gladys device per Zigbee device (keyed on the IEEE address, so renaming in
Zigbee2MQTT keeps the history), carrying:

- **Alive** — binary, `presence-sensor`, history kept. The feature to build the
  alert on.
- **Silence** — how many minutes the device has been quiet, to size the
  thresholds.
- **Link quality** — the LQI of its last message; a collapsing LQI usually
  announces the next device to die.

Plus one **Zigbee2MQTT monitor** device summarizing the network — silent count,
silent names (for the notification text), alive count, watched count, and the
bridge state. One scene on its `Silent devices > 0` covers every device,
including the ones paired next year.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + wiring (no decision logic)
├─ src/
│  ├─ monitor.js                     # the watchdog: last-seen, thresholds, verdict
│  ├─ messageRouter.js               # what counts as a sign of life
│  ├─ mqttClient.js                  # the broker connection
│  ├─ statePublisher.js              # deduplicated, rate-aware state publishing
│  ├─ lastSeenStore.js               # /data persistence, so a restart forgets nothing
│  ├─ actions.js                     # the Configuration screen buttons
│  ├─ config.js                      # config defaults, normalization, parsing
│  ├─ devices/                       # the Gladys device payloads
│  │  ├─ index.js                    #   registry: discovery list + states
│  │  ├─ zigbeeDevice.js             #   one device per Zigbee device
│  │  └─ monitorSummary.js           #   the network summary device
│  └─ z2m/
│     ├─ topics.js                   # Zigbee2MQTT topic parsing
│     └─ payloads.js                 # Zigbee2MQTT payload parsing
├─ docs/en.md, docs/fr.md            # user documentation (mandatory, re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## Design notes

**Rate limiting.** The host API accepts 300 states per minute per integration,
sized for state _changes_. Two of the three features are gauges that move on
their own (silence grows every minute, LQI wobbles on every report), so
[`src/statePublisher.js`](src/statePublisher.js) deduplicates and throttles them,
while `Alive` — the alert — is never held back.

**Persistence.** The last-seen map is written to `/data`, the single writable
volume of the sandbox. Without it, a container restart would hand a device that
died last month a brand new threshold and the alert would never fire.

**Never-seen devices** are measured from the moment the monitor started, so a
fresh install does not declare the whole network dead on its first tick.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="z2m-devices-monitor" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

The same three gates run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

The MQTT layer is tested against a **real broker** (`aedes`, in-process), so the
retained flag — the linchpin of the whole design — is verified rather than
assumed. See [`test/mqttClient.test.js`](test/mqttClient.test.js).

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks the store indexer applies — manifest schema, Docker image
availability, cover image, mandatory documentation — and reports everything at
once.

## Publishing

Push a multi-arch image and bump the version: **Actions → Release → Run
workflow**, pick patch/minor/major. It bumps `package.json` and the manifest,
tags, and builds `ghcr.io/<owner>/<repo>:<version>` for amd64 and arm64. Add the
`gladys-assistant-integration` GitHub topic to the repository and the store
indexer picks it up on its next run.

## License

[Apache-2.0](LICENSE)

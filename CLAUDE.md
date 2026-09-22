# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (a container the Gladys supervisor runs in a sandbox) that
watches Zigbee2MQTT devices and flags the ones that stopped giving signs of life. It only ever
subscribes to MQTT — it never publishes to the Zigbee network. Battery level is deliberately never
used as a health signal; silence is.

## Commands

```bash
npm ci                 # install (Node >= 20; CI and the image run Node 24)
npm test               # node --test, discovers test/*.test.js
npm run lint           # ESLint (flat config)
npm run format:check   # Prettier — CI fails on unformatted files
npm run format         # Prettier, write

node --test test/monitor.test.js                          # one file
node --test --test-name-pattern='retained' test/*.test.js # one test, by name

npx github:GladysAssistant/integration-store .            # the exact checks the store indexer runs
```

Running against a live Gladys instance:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="z2m-devices-monitor" \
LOG_LEVEL=debug npm start
```

The three `GLADYS_*` variables are injected by the supervisor in production; `new GladysIntegration()`
reads them itself.

ESM only (`"type": "module"`) — always use `import`, and include the `.js` extension in relative
specifiers.

## Architecture

One direction of flow, with `index.js` as wiring only (timers, debounces, lifecycle — **no decision
logic**):

```
MQTT broker → mqttClient.js → messageRouter.js → DevicesMonitor (pure state)
                                                       ↓ snapshot()
                                        devices/{index,zigbeeDevice,monitorSummary}.js
                                                       ↓ candidate states
                                            statePublisher.js → Gladys SDK
                                     snapshot() ↓
                 transitions.js (flips) → scenes.js (events)  ·  widget.js (content)
```

- **`src/monitor.js`** — the watchdog and the only source of truth for "is it alive?". Holds no I/O
  and takes an injectable `now()` clock, which is what makes the whole verdict testable without a
  broker. Fed via `recordActivity` / `setZ2mDevices` / `restore`, read via `snapshot()`.
- **`src/messageRouter.js` + `src/z2m/`** — turn raw MQTT traffic into monitor calls. `topics.js`
  classifies the topic, `payloads.js` tolerates the several shapes Zigbee2MQTT has published over
  its versions (returning `undefined` rather than throwing).
- **`src/devices/`** — pure snapshot→payload builders. Two device kinds: one Gladys device per
  Zigbee device, plus a singleton `Zigbee2MQTT monitor` summary device carrying network-wide
  counters (so one scene on `Silent devices > 0` covers devices paired later).
- **`src/statePublisher.js`** — dedupe/throttle layer in front of the rate-limited host API.
- **`src/lastSeenStore.js`** — `/data` persistence of the last-seen map and of the last verdicts.
- **`src/transitions.js`** — `AliveTransitions`: remembers each device's last verdict and reports the
  flips, which `index.js` fires as scene triggers.
- **`src/scenes.js`** — pure builders of the scene events and the scene action handlers
  (manifest `scene_triggers` / `scene_actions`).
- **`src/widget.js`** — the dashboard widget content (manifest `widgets`), in the core vocabulary.

### Invariants that are easy to break

These are the rules the design hangs on; the tests encode each of them.

**Signs of life.** A retained message is the broker replaying the _last_ thing a device said, not
proof it just spoke — counting retained reports as fresh would reset the whole network to "seen just
now" on every reconnection, including the sensor that died last week. A retained report is only
usable when it carries its own `last_seen`. `set`/`get` topics are traffic going _to_ the device and
never count. `device_announce` does.

**Identity.** Devices are keyed on the **IEEE address**, never the friendly name — renaming in
Zigbee2MQTT is one click and must not orphan the Gladys history. Friendly names may contain slashes,
so topics are parsed against the longest _known_ friendly-name prefix, not split naively. Activity
for a name that isn't resolvable yet (reports race the inventory on connect) is buffered in
`pendingByFriendlyName` and replayed on the next inventory — and `serialize()` persists those pending
entries too, otherwise a Zigbee2MQTT outage would quietly erase the history on the next write.
`mergeActivity` only ever moves `lastSeen` forward.

**Never-seen devices** are measured from `monitor.startedAt`, so a fresh install doesn't declare the
whole network dead on its first tick. Losing the `/data` history has the mirror effect: a device that
died last month looks healthy again for one full threshold.

**Gladys host API quirks** (each one cost a bug; the fake in `test/helpers/fakeGladys.js` reproduces
them):

- Features must declare `min`/`max` — they're `NOT NULL` in the Gladys schema and a feature without
  them makes the device impossible to create from the Discovery screen (HTTP 422).
- A state travels as a numeric `state` **or** a string `text`, never both, never a wrapper object.
  The API validates the _whole batch_ before saving any of it, so one malformed state discards the
  entire network's update.
- An empty `text` is accepted and then silently lost (the core dispatches on `if (event.text)`),
  leaving the feature reading "no value recorded" forever — hence the non-empty
  `no_silent_devices_text` guarantee in `normalizeConfig`.
- 300 states/min per integration, 100 per request. `Alive` is the alert and is never throttled;
  `Silence` is a gauge that moves every minute and carries a `minIntervalMs`. Unchanged values are
  still republished every `refreshMs` (30 min) so a device screen is never blank.
- Gladys drops states for features the user hasn't created yet, while the publisher believes them
  delivered — hence `publisher.forgetDevice()` on `onDeviceCreated` / `onDeviceUpdated`.
- A category/type pair the front does not know is accepted by the API and then drawn as an empty,
  unlabelled tag: the feature is invisible on the Discovery screen and the device looks like it only
  carries the other one. `presence-sensor` + `binary` is exactly that trap up to Gladys 4.85.0 (fixed
  on master, hence "works on my dev instance"), which is why `Alive` is an `input` + `binary`. Every
  pair published here must have both an icon in the front's `DeviceFeatureCategoriesIcon` and a
  `deviceFeatureCategory.<category>.<type>` label in the oldest Gladys the manifest supports.

**Scene triggers and widget** (Gladys >= 5.1.0).

- A trigger fires on a verdict **flip**, never on a state. A device the tracker sees for the first
  time is a baseline, so installing/upgrading announces nothing; the verdicts are persisted with the
  last-seen map (`verdicts` key, file version still 1), so a restart neither re-announces last
  week's death nor misses one that happened while the container was down.
- While the MQTT session is down or the bridge is offline the verdicts are **frozen**, not
  advanced: every device goes silent together then, and one event each would be a notification
  storm about a single failure. A device still dead once the network is back is announced then.
- Events go out after the states, so a scene reading `Alive` sees the new value. A failed event is
  not retried. Never fire an event from a scene action handler (the scene would loop).
- Scene/widget keys, field keys, variable and output keys are stored by the user's scenes and
  dashboards: never rename or remove one; a new `required` action field needs a `default`.
- A trigger filter only matches if its key is in the event data (`device` is the Gladys device
  `external_id`, what a `source: "devices"` select stores). `test/manifest.test.js` checks it.
- The widget is built from the snapshot, never bound to `device_feature`s: those read nothing until
  the user created the device, and the widget must work right after install. Check contents with
  `validateWidgetContent` — the core silently drops what breaks the budget.

**Sandbox.** The rootfs is read-only; `/data` (overridable via `GLADYS_DATA_DIR`) is the only
writable path. Writes are atomic (tmp + rename) and best-effort: a failure degrades the integration
to "forgets across restarts", it never takes it down.

## Manifest and configuration

`gladys-assistant-integration.json` is the user-facing contract: config schema, actions, version,
image. It's kept in sync with the code by `test/manifest.test.js`, which will fail if you:

- add a manifest action without exporting a handler from `src/actions.js` (or vice versa);
- add a config field without a matching key in `DEFAULT_CONFIG` (`src/config.js`), or let a `default`
  drift from it;
- give a `section` field a `default`/`required`/`placeholder`, or leak its key into `DEFAULT_CONFIG`;
- leave any user-facing string without both `en` and `fr`;
- declare more than three `categories`, or lower `gladys_version` below `>=4.86.0` while `categories`
  is declared — a core older than 4.86.0 rejects any manifest field it does not know, so the
  integration would fail to install instead of being filtered out of the catalog;
- lower `gladys_version` below `>=5.1.0` while `widgets` / `scene_triggers` / `scene_actions` are
  declared (same reason, one release later);
- let the widget, trigger or action keys drift from `WIDGET` / `SCENE_TRIGGER` / `SCENE_ACTION`, or
  a trigger field/variable be missing from the event data, or an action's outputs differ from what
  its handler returns.

`categories` are the catalog shelves the integration sits on (`network` alone here: it watches the
health of a Zigbee/MQTT network rather than driving a domain of the house — and it bridges no
protocol of its own, it only listens to one). The vocabulary is the store's, not ours — an unknown
key is dropped by the indexer with a warning, so a typo silently costs a shelf.

Every user-facing string in the code (action results, connection statuses) is likewise `{en, fr}`.
User documentation lives in `docs/en.md` and `docs/fr.md` — both mandatory, re-hosted by Gladys, and
kept in sync with each other.

Do **not** hand-edit `version` or `docker_image`: the Release workflow (Actions → Release → run,
pick patch/minor/major) bumps `package.json`, the manifest and the image tag together, then builds
the multi-arch image.

## Conventions

Every module opens with a comment block explaining _why_ it exists and which failure it prevents;
exported functions and classes carry JSDoc with typed `@param`/`@returns`. Match that density —
the comments here document decisions and traps, not mechanics. Prettier settings: 100 columns,
single quotes, trailing commas.

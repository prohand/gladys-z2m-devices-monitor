# Z2M Devices Monitor — documentation

This integration watches your Zigbee2MQTT devices and alerts you when one of them
**stops giving signs of life**.

## Why not the battery level

The battery percentage a Zigbee device reports is a coarse, rarely refreshed and
often plainly wrong estimate: a CR2032 sensor commonly reads 100% right up to the
day it stops answering. More importantly, the battery says nothing about the
other ways a device dies: unplugged, dropped off the network, route lost, or
parent router down.

A Zigbee device that is alive **talks**. Sensors send their readings, routers
answer, everything reports at least periodically. So the only reliable fact is
_when did I last hear from this device?_ — and the only useful question is _has
it been silent for longer than it should?_

That is exactly what this integration does.

## What it does

It subscribes to everything Zigbee2MQTT publishes on your MQTT broker
(`zigbee2mqtt/#`), remembers when each device last spoke, and continuously
re-evaluates their silence.

It **never** publishes anything to your Zigbee network: it only listens. It also
tells apart:

- a message published **by** the device → proof it is alive;
- a message replayed by the broker (the _retained_ flag, on every reconnection) →
  it may be days old, it proves nothing;
- a `set`/`get` command sent **to** the device by Gladys, Home Assistant or a
  scene → that is not the device talking. Without that distinction, a dead sensor
  would look alive for as long as something keeps talking to it.

If you enabled the `advanced.last_seen` option in Zigbee2MQTT, the integration
uses the timestamp devices attach to their reports: the most reliable source
there is, and the one that even makes retained messages usable. It is not
required.

## Setup

### 1. Requirements

- Zigbee2MQTT running and publishing to an MQTT broker;
- that broker reachable from Gladys (same local network).

### 2. Configuration

| Field                   | What to fill in                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Broker URL**          | The address of your MQTT broker, e.g. `mqtt://192.168.1.10:1883`. The `mqtts://`, `ws://` and `wss://` schemes are supported too. |
| **Username / Password** | Leave empty if your broker allows anonymous connections.                                                                          |
| **Base topic**          | The `mqtt.base_topic` configured in Zigbee2MQTT. `zigbee2mqtt` in almost every case.                                              |

Then click **Test the MQTT connection**: the button reports whether it is
connected, how many devices it sees and how many messages it received. It is the
fastest way to catch the classic mistake — right broker, wrong base topic, and
nothing happens at all.

### 3. Add the devices

Go to **Devices → Discover**, then create the devices you want to watch. You will
find:

- one device **per Zigbee device** known to Zigbee2MQTT;
- one **Zigbee2MQTT monitor** device summarizing the whole network.

Watched devices carry their Zigbee2MQTT name **followed by a suffix**,
`(monitor)` by default: `office plug (monitor)`. Without it they would be
impossible to tell apart from the devices Gladys already exposes under the very
same name through its own Zigbee2MQTT integration — a scene picker would show
"office plug" twice. Change it (or empty it) under **Device naming**. It only
applies to the devices you create afterwards: Gladys never renames a device you
already added, rename it yourself on its page.

### What happens when the Zigbee network changes?

The integration keeps re-reading the Zigbee2MQTT inventory, so the **Discover**
screen updates on its own:

- **a device you just paired** shows up in the list within seconds, with no
  restart and nothing to click. Creating it in Gladys stays **manual** though —
  what enters your installation is your call. That is also why the scene worth
  building is the one on the **Zigbee2MQTT monitor** device: its counters cover
  every device Zigbee2MQTT knows about, including the ones you never created in
  Gladys, so a newly paired device is covered by the alert from the moment it
  joins;
- **a device removed from Zigbee2MQTT** disappears from the **Discover** screen
  and stops being counted and publishing values. If you had already created it in
  Gladys, its device is **not deleted automatically**: it stays, frozen on its
  last value. An integration is not allowed to delete your devices — remove it
  from **Devices** whenever you want.

## Silence thresholds

A device is declared dead once it has been silent for longer than its threshold.
Two defaults:

- **mains-powered devices** (plugs, bulbs, routers): 120 minutes, they report
  often;
- **battery devices** (sensors): 1440 minutes, i.e. 24 hours — they sleep most of
  the time.

You can refine device by device in the **Per-device thresholds** field, one
`device=minutes` pair per line or separated by commas:

```
mailbox sensor=4320
garage motion=180
0x00158d0001abcdef=60
```

The device is designated by its Zigbee2MQTT friendly name or its IEEE address.

**Start generous.** A tight threshold produces false alerts, and an alert nobody
believes anymore is worthless. Let it run for a few days, look at the "Silence"
value on each device screen, then tighten.

## What each device exposes

| Feature          | Description                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Alive**        | 1 = the device is giving signs of life, 0 = it has been silent for longer than its threshold. This is the feature to build an alert on. Its history is kept. |
| **Silence**      | How many minutes the device has been quiet. Useful to size the thresholds.                                                                                   |
| **Link quality** | The LQI of its last message. An LQI that has been collapsing for weeks often announces the next device to die.                                               |

The **Zigbee2MQTT monitor** device exposes:

| Feature                                   | Description                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Silent devices**                        | How many devices are currently silent.                                                         |
| **Silent device names**                   | Their names, so a notification can quote them. Reads `-` while the whole network is answering. |
| **Devices alive** / **Devices monitored** | The network counters.                                                                          |
| **Zigbee2MQTT bridge online**             | The state of the Zigbee2MQTT bridge itself.                                                    |

## Getting alerted: the scene

The integration raises the flag, Gladys sends the alert. The most useful scene is
the one built on the **Zigbee2MQTT monitor** device: it covers the whole network,
including the devices you will pair six months from now.

1. **Scenes → New scene**;
2. trigger: **A device value changes** → device _Zigbee2MQTT monitor_, feature
   **Silent devices**, condition _greater than_ `0`;
3. action: **Send a message** (mobile notification, Telegram…) with something
   like:

   > Zigbee device(s) with no sign of life: {{device.z2m-monitor-silent-names}}

   Use the picker offered by the scene editor to insert the **Silent device
   names** feature: the message will name the sensors involved instead of just
   saying something is wrong.

For one particularly critical sensor (smoke detector, alarm, freezer), add a
dedicated scene on its **Alive** feature turning to 0.

Tip: add a time condition to the scene if you would rather not be woken up at
night — a silent sensor can almost always wait until morning.

## The buttons on the Configuration screen

- **Test the MQTT connection** — the live connection state, how many devices are
  watched, how many messages were received, and the precise reason on failure.
- **List the silent devices** — who is quiet, and for how long.
- **Refresh the device list** — republishes the list to Gladys, after a pairing
  or a rename in Zigbee2MQTT.

## Good to know

- **Devices are identified by their IEEE address**, not by their name. Renaming a
  device in Zigbee2MQTT updates its name in Gladys without losing its history.
- **Devices disabled in Zigbee2MQTT are not watched** by default: they are
  supposed to be silent. An option lets you include them.
- **The coordinator (the USB stick) is not watched**: it is not a device that can
  fall off on its own. Use the _Zigbee2MQTT bridge online_ feature for that.
- **The last-seen history is persisted** in the integration's `/data` volume. A
  container restart therefore does not reset every device — otherwise a sensor
  that died a month ago would start a fresh threshold and the alert would never
  fire.
- **A device never heard from** gets one full threshold from the moment the
  monitor started before being flagged. A freshly installed integration does not
  declare the whole network dead on its first minute.

## Troubleshooting

**The test button says it is not connected.** Check the URL (with the port,
`1883` by default), the credentials, and that the broker accepts connections from
the Gladys machine.

**It is connected, but sees no device.** The base topic probably does not match
the one Zigbee2MQTT uses. Compare it with `mqtt.base_topic` in your
`configuration.yaml`.

**A device is flagged silent while it works fine.** Its threshold is too tight:
look at its _Silence_ feature to learn its real rhythm, then give it a custom
threshold. Door, leak and button sensors are typically quiet for days when
nothing happens.

**Every device goes silent at once.** Check _Zigbee2MQTT bridge online_ first: it
is most likely Zigbee2MQTT itself, the broker or the coordinator that went down,
not your sensors.

**A device I just added reads "no recent value".** A feature only gets a value
once the device exists in Gladys, so everything published before you pressed
_Add_ went nowhere. The integration republishes the states of a device the moment
Gladys tells it the device was created, so the value lands within a couple of
seconds. If the badge is still there, **reload the page**: the dashboard computes
the "no recent value" badge when it loads its data and does not clear it on the
live updates that follow.

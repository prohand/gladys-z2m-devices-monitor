// -----------------------------------------------------------------------------
// The dashboard widget (manifest `widgets`, Gladys >= 5.1.0).
//
// Without it, the health of the network is spread over one device card per
// sensor plus the summary device — and the summary device only shows up on a
// dashboard once the user created it and picked its features one by one. The
// widget is the one-glance answer: how many are silent, which ones, since when,
// and whether Zigbee2MQTT itself is up.
//
// The content is built from a snapshot, never bound to device features: a
// `device_feature` tile reads nothing until the user created that device in
// Gladys, and this widget has to work the minute the integration is installed.
// The price is freshness — handled by `ttl_seconds` plus a refresh nudge when
// the picture actually changes (`networkHealthSignature`).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { describeBridge, formatDuration } from './actions.js';
import { filterByPowerSource, isBatteryPowered } from './monitor.js';

export const WIDGET = {
  NETWORK_HEALTH: 'network_health',
};

// Silence moves by the minute; the list only changes on a verdict flip, which
// comes with a refresh nudge anyway.
const TTL_SECONDS = 60;

// The status component holds at most 10 rows, and the bridge takes the first.
const MAX_SILENT_ROWS = 9;

/**
 * Build the content of the `network_health` widget.
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 * @param {Record<string, unknown>} [settings] - Widget instance settings (`power_source`).
 * @returns {{ttl_seconds: number, components: Array<object>}} The widget content, in the core vocabulary.
 */
export function buildNetworkHealthWidget(snapshot, settings = {}) {
  if (!snapshot.summary.inventoryReceived) {
    // Zeros here would read "all good" while the monitor knows nothing yet.
    return {
      ttl_seconds: 30,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: {
            en: 'Waiting for the Zigbee2MQTT device inventory. Check the MQTT connection from the integration page if this lasts.',
            fr: "En attente de l'inventaire des appareils Zigbee2MQTT. Vérifiez la connexion MQTT depuis la page de l'intégration si cela dure.",
          },
        },
      ],
    };
  }

  const watched = filterByPowerSource(
    snapshot.devices.filter((device) => device.monitored),
    settings.power_source,
  );
  const silent = watched.filter((device) => !device.alive);

  return {
    ttl_seconds: TTL_SECONDS,
    components: [
      {
        type: 'value',
        label: { en: 'Silent', fr: 'Silencieux' },
        value: silent.length,
        icon: 'alert-triangle',
        color: silent.length > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
      },
      {
        type: 'value',
        label: { en: 'Alive', fr: 'En vie' },
        value: watched.length - silent.length,
        icon: 'check-circle',
        color: WIDGET_COLORS.SUCCESS,
      },
      {
        type: 'value',
        label: { en: 'Watched', fr: 'Surveillés' },
        value: watched.length,
        icon: 'eye',
        color: WIDGET_COLORS.NEUTRAL,
      },
      { type: 'status', items: [bridgeRow(snapshot.summary.bridgeOnline), ...silentRows(silent)] },
    ],
  };
}

/**
 * What the widget shows, reduced to a string: when it changes, the content on
 * the dashboards is stale and worth a refresh nudge. The silence durations are
 * left out on purpose — they move every minute and the TTL covers them.
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 * @returns {string} A signature of the widget-relevant state.
 */
export function networkHealthSignature(snapshot) {
  const { summary } = snapshot;
  const silent = summary.silentDevices.map((device) => device.ieeeAddress).join(',');
  return `${summary.inventoryReceived}|${summary.bridgeOnline}|${summary.monitored}|${silent}`;
}

/**
 * The bridge row, first of the status list: when every device is silent, it is
 * the one line that says why.
 * @param {boolean|null} bridgeOnline - Bridge state held by the monitor.
 * @returns {object} A status row.
 */
function bridgeRow(bridgeOnline) {
  let color = WIDGET_COLORS.NEUTRAL;
  if (bridgeOnline !== null) {
    color = bridgeOnline ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER;
  }
  return {
    label: { en: 'Zigbee2MQTT bridge', fr: 'Bridge Zigbee2MQTT' },
    value: describeBridge(bridgeOnline),
    icon: 'radio',
    color,
  };
}

/**
 * One row per silent device, or a single "none" row. Past the row budget the
 * last row counts the others, instead of letting the core drop them unsaid.
 * @param {Array<object>} silent - Silent devices of a snapshot.
 * @returns {Array<object>} Status rows.
 */
function silentRows(silent) {
  if (silent.length === 0) {
    return [
      {
        label: { en: 'Silent devices', fr: 'Appareils silencieux' },
        value: { en: 'none', fr: 'aucun' },
        icon: 'check',
        color: WIDGET_COLORS.SUCCESS,
      },
    ];
  }
  const overflow = silent.length > MAX_SILENT_ROWS;
  const listed = overflow ? silent.slice(0, MAX_SILENT_ROWS - 1) : silent;
  const rows = listed.map((device) => ({
    label: device.friendlyName,
    value: device.neverSeen
      ? { en: 'never seen', fr: 'jamais vu' }
      : {
          en: formatDuration(device.silenceMinutes, 'en'),
          fr: formatDuration(device.silenceMinutes, 'fr'),
        },
    icon: isBatteryPowered(device) ? 'battery' : 'zap',
    color: WIDGET_COLORS.DANGER,
  }));
  if (overflow) {
    rows.push({
      label: { en: 'Other silent devices', fr: 'Autres appareils silencieux' },
      value: silent.length - listed.length,
      icon: 'more-horizontal',
      color: WIDGET_COLORS.DANGER,
    });
  }
  return rows;
}

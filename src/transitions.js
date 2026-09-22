// -----------------------------------------------------------------------------
// Alive/silent transitions, the source of the scene triggers.
//
// The `Alive` feature already tells a scene that a device went quiet, and the
// summary device that "something" did. What neither can do is fire once PER
// device: a scene on "Silent devices > 0" runs when the first sensor dies and
// stays quiet when a second one follows. A scene trigger is an event — "this
// device just went silent" — so this module remembers the last verdict of each
// device and reports the flips, nothing else.
//
// Three rules keep it from crying wolf:
//   - a device seen for the first time is a baseline, never a flip: without it,
//     installing the integration (or upgrading to the first version carrying
//     the triggers) would fire one event per dead device already known;
//   - the verdicts survive a restart (`serialize`/`restore`, next to the
//     last-seen map): otherwise a device that died last week would be
//     "newly silent" again on every container update — and one that died
//     while the container was down would never be announced at all;
//   - while the monitor cannot hear the network (broker unreachable, bridge
//     offline) the verdicts are frozen: every device goes silent together
//     then, and the bridge feature already says why. Frozen rather than
//     skipped, so a device still dead once the network is back is announced
//     at that point, and one that came back is not announced at all.
//
// No I/O here either: `index.js` turns the flips into `publishSceneEvent`.
// -----------------------------------------------------------------------------

export class AliveTransitions {
  constructor() {
    /** @type {Map<string, boolean>} IEEE address -> last verdict (true = alive). */
    this.verdicts = new Map();
  }

  /**
   * Compare a snapshot with the last verdicts and advance them.
   * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
   * @param {object} [options] - Options.
   * @param {boolean} [options.listening] - False while the MQTT session is down.
   * @returns {Array<{type: 'silent'|'back', device: object}>} The flips, in snapshot order.
   */
  diff(snapshot, { listening = true } = {}) {
    // An empty inventory is "not received yet", not "every device left": keep
    // the verdicts restored from disk until Zigbee2MQTT tells us who is there.
    if (!snapshot.summary.inventoryReceived) {
      return [];
    }
    if (!listening || snapshot.summary.bridgeOnline === false) {
      return [];
    }

    const flips = [];
    const watched = new Set();
    for (const device of snapshot.devices) {
      if (!device.monitored) {
        continue;
      }
      watched.add(device.ieeeAddress);
      const previous = this.verdicts.get(device.ieeeAddress);
      if (previous !== undefined && previous !== device.alive) {
        flips.push({ type: device.alive ? 'back' : 'silent', device });
      }
      this.verdicts.set(device.ieeeAddress, device.alive);
    }

    // A device that left the network, or that the user excluded, starts from a
    // fresh baseline if it ever comes back.
    for (const ieee of this.verdicts.keys()) {
      if (!watched.has(ieee)) {
        this.verdicts.delete(ieee);
      }
    }
    return flips;
  }

  /**
   * Replay the verdicts persisted by a previous run.
   * @param {Record<string, unknown>} saved - Persisted map, keyed by IEEE address.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') {
      return;
    }
    for (const [ieee, alive] of Object.entries(saved)) {
      if (typeof alive === 'boolean') {
        this.verdicts.set(ieee, alive);
      }
    }
  }

  /**
   * Build the payload to persist, so `restore()` can replay it after a restart.
   * @returns {Record<string, boolean>} Last verdicts, keyed by IEEE address.
   */
  serialize() {
    return Object.fromEntries(this.verdicts);
  }
}

// -----------------------------------------------------------------------------
// State publishing, deduplicated and rate-aware.
//
// The host API rate-limits `POST /state` at 300 states per minute per
// integration, and it is sized for state CHANGES, not for full snapshots. This
// integration re-evaluates every device on every tick, so it would happily blow
// through that budget on a large network — and two of its three features are
// gauges that change on their own:
//
//   - "Alive" only moves when a device dies or comes back: plain deduplication
//     is enough, and every change goes out immediately (it is the alert).
//   - "Silence" grows by one every single minute, and "Link quality" wobbles on
//     every report. Publishing them blindly would spend the whole budget on
//     counters nobody is watching, so they carry a `minIntervalMs`: their value
//     is refreshed at most that often.
//
// Unchanged values are still republished once in a while (`refreshMs`), so a
// device screen opened after a long quiet period is never blank.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'states' });

// Max states per `publishStates` request, imposed by the host API.
const BATCH_SIZE = 100;

const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

export class StatePublisher {
  /**
   * @param {object} options - Options.
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys - The SDK instance.
   * @param {number} [options.refreshMs] - Republish an unchanged value after this long.
   * @param {() => number} [options.now] - Clock, injectable for the tests.
   */
  constructor({ gladys, refreshMs = DEFAULT_REFRESH_MS, now = () => Date.now() }) {
    this.gladys = gladys;
    this.refreshMs = refreshMs;
    this.now = now;
    /** @type {Map<string, {value: unknown, at: number}>} */
    this.published = new Map();
  }

  /**
   * Forget what was published — called on reconnection, because Gladys
   * resynchronizes and we want the current picture pushed again in full.
   */
  reset() {
    this.published.clear();
  }

  /**
   * Keep only the states worth sending.
   * @param {Array<{device_feature_external_id: string, state?: number, text?: string, minIntervalMs?: number}>} states - Candidate states.
   * @returns {Array<{device_feature_external_id: string, state?: number, text?: string}>} The states to send, stripped of their publishing hints.
   */
  selectChanged(states) {
    const now = this.now();
    const selected = [];
    for (const { device_feature_external_id, state, text, minIntervalMs = 0 } of states) {
      const value = text !== undefined ? text : state;
      const previous = this.published.get(device_feature_external_id);
      if (previous !== undefined) {
        const age = now - previous.at;
        if (previous.value === value) {
          if (age < this.refreshMs) {
            continue; // nothing new, and the periodic refresh is not due
          }
        } else if (age < minIntervalMs) {
          continue; // a gauge moving faster than it is worth reporting
        }
      }
      // The host API validates the WHOLE batch before saving anything, and takes
      // a numeric `state` or a string `text` — never a wrapper object. Send back
      // exactly the field the feature carries, so one text state cannot discard
      // the states of the entire network.
      selected.push(
        text !== undefined
          ? { device_feature_external_id, text }
          : { device_feature_external_id, state },
      );
    }
    return selected;
  }

  /**
   * Publish a batch of states, dropping the ones `selectChanged` filters out and
   * chunking the rest to the size the host API accepts.
   * @param {Array<{device_feature_external_id: string, state: unknown, minIntervalMs?: number}>} states - Candidate states.
   * @returns {Promise<number>} How many states were actually sent.
   */
  async publish(states) {
    const selected = this.selectChanged(states);
    if (selected.length === 0) {
      return 0;
    }

    for (let index = 0; index < selected.length; index += BATCH_SIZE) {
      const batch = selected.slice(index, index + BATCH_SIZE);
      await this.gladys.publishStates(batch);
      // Only remember what Gladys accepted: a failed batch throws here, so it is
      // retried on the next tick instead of being considered published.
      const at = this.now();
      for (const state of batch) {
        const value = state.text !== undefined ? state.text : state.state;
        this.published.set(state.device_feature_external_id, { value, at });
      }
    }

    logger.debug(`Published ${selected.length} state(s) out of ${states.length} evaluated`);
    return selected.length;
  }
}

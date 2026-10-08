// -----------------------------------------------------------------------------
// State publishing, deduplicated and rate-aware.
//
// The host API rate-limits `POST /state` at 300 states per minute per
// integration, and it is sized for state CHANGES, not for full snapshots. This
// integration re-evaluates every device on every tick, so it would happily blow
// through that budget on a large network — and one of its two per-device
// features is a gauge that changes on its own:
//
//   - "Alive" only moves when a device dies or comes back: plain deduplication
//     is enough, and every change goes out immediately (it is the alert).
//   - "Silence" grows by one every single minute. Publishing it blindly would
//     spend the whole budget on a counter nobody is watching, so it carries a
//     `minIntervalMs`: its value is refreshed at most that often.
//
// Unchanged values are still republished once in a while (`refreshMs`), so a
// device screen opened after a long quiet period is never blank. That refresh
// carries a random jitter per feature: without it every unchanged feature of
// the network came due on the very same tick, every half hour, in one burst.
//
// The budget itself is enforced here too, because dedupe alone does not bound a
// FULL pass — the one after a reconnection, or the one a large network sends
// when it first starts: 150 devices are 300 states plus the summary. A sliding
// one-minute window caps what goes out (`statesPerMinute`, under the host
// limit), the alerts first; what does not fit is simply not recorded as
// published, so the next pass sends it. And a 429 the host answers anyway
// (another request of ours, a smaller limit) is waited out and retried once
// rather than dropped.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'states' });

// Max states per `publishStates` request, imposed by the host API.
const BATCH_SIZE = 100;

// The host accepts 300 states per minute per integration; keep some headroom
// for the clock skew between its window and ours.
export const STATES_PER_MINUTE = 250;
const WINDOW_MS = 60 * 1000;

const DEFAULT_REFRESH_MS = 30 * 60 * 1000;
// The periodic refresh of a feature comes due somewhere in the last 20 % of
// `refreshMs`, drawn again on every publish.
export const REFRESH_JITTER = 0.2;

// How long to wait after a 429 when the error does not say. The SDK (0.14)
// does not surface the `Retry-After` header: `retryAfter` (seconds) is read
// when an error carries it, this default otherwise — one full window, so the
// retry lands in a fresh one. Capped either way: a pass must not hang.
const DEFAULT_RETRY_AFTER_MS = WINDOW_MS;
export const MAX_RETRY_AFTER_MS = 2 * WINDOW_MS;

export class StatePublisher {
  /**
   * @param {object} options - Options.
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys - The SDK instance.
   * @param {number} [options.refreshMs] - Republish an unchanged value after about this long.
   * @param {number} [options.statesPerMinute] - Budget of states sent per sliding minute.
   * @param {() => number} [options.now] - Clock, injectable for the tests.
   * @param {() => number} [options.random] - Source of the refresh jitter, in [0, 1).
   * @param {(ms: number) => Promise<void>} [options.sleep] - Waits, injectable for the tests.
   */
  constructor({
    gladys,
    refreshMs = DEFAULT_REFRESH_MS,
    statesPerMinute = STATES_PER_MINUTE,
    now = () => Date.now(),
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.gladys = gladys;
    this.refreshMs = refreshMs;
    this.statesPerMinute = statesPerMinute;
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    /** @type {Map<string, {value: unknown, at: number, refreshAt: number}>} */
    this.published = new Map();
    /** @type {Array<{at: number, count: number}>} What went out in the current window. */
    this.window = [];
  }

  /**
   * Forget what was published — called on reconnection, because Gladys
   * resynchronizes and we want the current picture pushed again in full.
   */
  reset() {
    this.published.clear();
  }

  /**
   * Forget what was published for ONE device.
   *
   * Gladys silently drops the states of a feature the user has not created yet
   * — the integration publishes its whole network from the first tick, long
   * before anything is added from the Discovery screen. Those states went
   * nowhere, but the publisher believes them delivered and would stay quiet
   * until the periodic refresh, leaving a freshly added device blank for half
   * an hour. Forgetting it on creation is what makes it show a value at once.
   * @param {string} deviceExternalId - External id of the device (its features are prefixed with it).
   */
  forgetDevice(deviceExternalId) {
    if (!deviceExternalId) {
      return;
    }
    const prefix = `${deviceExternalId}:`;
    for (const key of this.published.keys()) {
      if (key === deviceExternalId || key.startsWith(prefix)) {
        this.published.delete(key);
      }
    }
  }

  /**
   * Keep only the states worth sending, the alerts first.
   *
   * A state with no `minIntervalMs` is one that only moves on an event (an
   * `Alive` flip, a count of silent devices); a throttled one is a gauge. When
   * the budget cannot take everything, the gauges are what waits.
   * @param {Array<{device_feature_external_id: string, state?: number, text?: string, minIntervalMs?: number}>} states - Candidate states.
   * @returns {Array<{device_feature_external_id: string, state?: number, text?: string}>} The states to send, stripped of their publishing hints.
   */
  selectChanged(states) {
    const now = this.now();
    const alerts = [];
    const gauges = [];
    for (const { device_feature_external_id, state, text, minIntervalMs = 0 } of states) {
      const value = text !== undefined ? text : state;
      const previous = this.published.get(device_feature_external_id);
      if (previous !== undefined) {
        if (previous.value === value) {
          if (now < previous.refreshAt) {
            continue; // nothing new, and the periodic refresh is not due
          }
        } else if (now - previous.at < minIntervalMs) {
          continue; // a gauge moving faster than it is worth reporting
        }
      }
      // The host API validates the WHOLE batch before saving anything, and takes
      // a numeric `state` or a string `text` — never a wrapper object. Send back
      // exactly the field the feature carries, so one text state cannot discard
      // the states of the entire network.
      (minIntervalMs > 0 ? gauges : alerts).push(
        text !== undefined
          ? { device_feature_external_id, text }
          : { device_feature_external_id, state },
      );
    }
    return [...alerts, ...gauges];
  }

  /**
   * How many states the current sliding minute can still take.
   * @returns {number} The remaining budget, never negative.
   */
  remainingBudget() {
    const since = this.now() - WINDOW_MS;
    this.window = this.window.filter((entry) => entry.at > since);
    const spent = this.window.reduce((total, entry) => total + entry.count, 0);
    return Math.max(0, this.statesPerMinute - spent);
  }

  /**
   * Publish a batch of states, dropping the ones `selectChanged` filters out,
   * keeping to the per-minute budget and chunking the rest to the size the
   * host API accepts.
   * @param {Array<{device_feature_external_id: string, state: unknown, minIntervalMs?: number}>} states - Candidate states.
   * @returns {Promise<number>} How many states were actually sent.
   */
  async publish(states) {
    const selected = this.selectChanged(states);
    if (selected.length === 0) {
      return 0;
    }
    const allowed = selected.slice(0, this.remainingBudget());
    if (allowed.length < selected.length) {
      // Not recorded as published: the next pass picks them up.
      logger.debug(
        `Rate budget reached: ${selected.length - allowed.length} state(s) deferred to the next pass`,
      );
    }

    for (let index = 0; index < allowed.length; index += BATCH_SIZE) {
      const batch = allowed.slice(index, index + BATCH_SIZE);
      await this.send(batch);
      // Only remember what Gladys accepted: a failed batch throws here, so it is
      // retried on the next tick instead of being considered published.
      const at = this.now();
      this.window.push({ at, count: batch.length });
      for (const state of batch) {
        const value = state.text !== undefined ? state.text : state.state;
        const refreshAt = at + this.refreshMs * (1 - REFRESH_JITTER * this.random());
        this.published.set(state.device_feature_external_id, { value, at, refreshAt });
      }
    }

    if (allowed.length > 0) {
      logger.debug(`Published ${allowed.length} state(s) out of ${states.length} evaluated`);
    }
    return allowed.length;
  }

  /**
   * Send one batch; on a 429, wait as long as the host asks (capped) and try
   * once more. A second refusal fills the window, so the passes that follow
   * within the minute do not hammer the host, and is thrown.
   * @param {Array<object>} batch - At most `BATCH_SIZE` states.
   * @returns {Promise<void>} Resolves once Gladys accepted the batch.
   */
  async send(batch) {
    try {
      await this.gladys.publishStates(batch);
      return;
    } catch (err) {
      if (err?.status !== 429) {
        throw err;
      }
      const delay = retryDelayMs(err);
      logger.warn(`Host API rate limit hit, retrying ${batch.length} state(s) in ${delay} ms`);
      await this.sleep(delay);
    }
    try {
      await this.gladys.publishStates(batch);
    } catch (err) {
      if (err?.status === 429) {
        this.window.push({ at: this.now(), count: this.statesPerMinute });
      }
      throw err;
    }
  }
}

/**
 * How long to wait before retrying a request the host refused with a 429.
 * @param {{retryAfter?: unknown}} err - The error thrown by the SDK.
 * @returns {number} Milliseconds, between 0 and `MAX_RETRY_AFTER_MS`.
 */
export function retryDelayMs(err) {
  const seconds = Number(err?.retryAfter);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

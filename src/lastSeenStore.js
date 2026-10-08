// -----------------------------------------------------------------------------
// Persistence of the last-seen timestamps.
//
// Why it matters: the whole verdict of this integration is "how long has it been
// silent?". If that memory is lost on every container restart, a device that
// died last month looks perfectly healthy again for one full threshold — and the
// user is never alerted. So the map is written to `/data`, the single writable
// volume of the sandbox (the rest of the rootfs is mounted read-only).
//
// The same file carries the last alive/silent verdict of each device (see
// `transitions.js`): the scene triggers fire on a verdict FLIP, and a flip is
// only a flip if the verdict before the restart is known. And `heard_at`, the
// last moment the monitor could hear the network: the container being down is
// an outage, and the monitor forgives an outage only when it knows when it
// began (see `DevicesMonitor.restore`).
//
// Writing is best-effort: a broken or read-only volume degrades the integration
// to "forgets across restarts", it never takes it down.
//
// Two saves can overlap — the periodic one and the shutdown one, typically —
// and they used to share a single `.tmp` path: the second `writeFile` truncated
// the file the first was about to rename, which could land a half-written or
// interleaved history on disk. Saves are now queued one after the other (so the
// last one asked is the last one written), and each write gets a temporary name
// of its own anyway, so even a second store on the same file cannot collide.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'store' });

// Still 1: `verdicts` and `heard_at` are additions an older reader simply
// ignores, and a file written before them reads as "no verdict yet" — a
// baseline, never a flip — and "no known outage".
const FILE_VERSION = 1;

/** @typedef {{devices: Record<string, {last_seen: number}>, verdicts: Record<string, boolean>, heardAt?: number|null}} PersistedHistory */

export class LastSeenStore {
  /**
   * @param {object} [options] - Options.
   * @param {string} [options.filePath] - Where to persist. Defaults to `/data/last-seen.json`.
   */
  constructor({ filePath = join(process.env.GLADYS_DATA_DIR ?? '/data', 'last-seen.json') } = {}) {
    this.filePath = filePath;
    this.writeFailureLogged = false;
    /** Tail of the save queue: every save waits for the previous one. */
    this.pending = Promise.resolve(true);
    this.writeCount = 0;
  }

  /**
   * Read the persisted history.
   * @returns {Promise<PersistedHistory>} The history, empty on a first run or an unreadable file.
   */
  async load() {
    const empty = { devices: {}, verdicts: {}, heardAt: null };
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.filePath}, starting with an empty history`, err);
      }
      return empty;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== FILE_VERSION || typeof parsed.devices !== 'object') {
        logger.warn(`Ignoring ${this.filePath}: unexpected format`);
        return empty;
      }
      logger.info(`Restored ${Object.keys(parsed.devices).length} last-seen timestamps`);
      const verdicts =
        parsed.verdicts && typeof parsed.verdicts === 'object' ? parsed.verdicts : {};
      const heardAt = Number.isFinite(parsed.heard_at) ? parsed.heard_at : null;
      return { devices: parsed.devices, verdicts, heardAt };
    } catch (err) {
      logger.warn(`Ignoring ${this.filePath}: invalid JSON`, err);
      return empty;
    }
  }

  /**
   * Persist the history, atomically (write to a temporary file then rename) so
   * a container killed mid-write never leaves a truncated file.
   *
   * Saves are serialized: one asked while another is running waits for it, so
   * two writes never race on the same file and the most recent history is the
   * one left on disk.
   * @param {object} history - What to persist.
   * @param {Record<string, {last_seen: number}>} history.devices - Last-seen map, keyed by IEEE address.
   * @param {Record<string, boolean>} [history.verdicts] - Last verdicts, keyed by IEEE address.
   * @param {number|null} [history.heardAt] - Last moment the monitor could hear the network.
   * @returns {Promise<boolean>} True when the write succeeded.
   */
  save(history) {
    // The payload is captured NOW, not when the queue reaches it: a save is a
    // picture of the moment it was asked for.
    const payload = JSON.stringify(toFile(history));
    const run = this.pending.then(() => this.write(payload));
    this.pending = run;
    return run;
  }

  /**
   * Write one payload to disk through a temporary file of its own.
   * @param {string} payload - Serialized history.
   * @returns {Promise<boolean>} True when the write succeeded.
   */
  async write(payload) {
    this.writeCount += 1;
    // pid + counter + random: unique per write, per store and per process.
    const unique = `${process.pid}.${this.writeCount}.${randomBytes(4).toString('hex')}`;
    const temporaryPath = `${this.filePath}.${unique}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, payload, 'utf8');
      await rename(temporaryPath, this.filePath);
      this.writeFailureLogged = false;
      return true;
    } catch (err) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      // Log the first failure only: a read-only volume would otherwise fill the
      // logs with the same line every few minutes.
      if (!this.writeFailureLogged) {
        this.writeFailureLogged = true;
        logger.error(
          `Cannot persist the last-seen history to ${this.filePath}: the monitor will forget it on restart`,
          err,
        );
      }
      return false;
    }
  }
}

/**
 * The on-disk shape of a history.
 * @param {{devices: object, verdicts?: object, heardAt?: number|null}} history - What to persist.
 * @returns {object} The JSON document written to `/data`.
 */
function toFile({ devices, verdicts = {}, heardAt = null }) {
  const file = { version: FILE_VERSION, devices, verdicts };
  if (Number.isFinite(heardAt)) {
    file.heard_at = heardAt;
  }
  return file;
}

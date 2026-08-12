// -----------------------------------------------------------------------------
// Persistence of the last-seen timestamps.
//
// Why it matters: the whole verdict of this integration is "how long has it been
// silent?". If that memory is lost on every container restart, a device that
// died last month looks perfectly healthy again for one full threshold — and the
// user is never alerted. So the map is written to `/data`, the single writable
// volume of the sandbox (the rest of the rootfs is mounted read-only).
//
// Writing is best-effort: a broken or read-only volume degrades the integration
// to "forgets across restarts", it never takes it down.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'store' });

const FILE_VERSION = 1;

export class LastSeenStore {
  /**
   * @param {object} [options] - Options.
   * @param {string} [options.filePath] - Where to persist. Defaults to `/data/last-seen.json`.
   */
  constructor({ filePath = join(process.env.GLADYS_DATA_DIR ?? '/data', 'last-seen.json') } = {}) {
    this.filePath = filePath;
    this.writeFailureLogged = false;
  }

  /**
   * Read the persisted last-seen map.
   * @returns {Promise<Record<string, {last_seen: number}>>} The map, empty on a first run or an unreadable file.
   */
  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.filePath}, starting with an empty history`, err);
      }
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== FILE_VERSION || typeof parsed.devices !== 'object') {
        logger.warn(`Ignoring ${this.filePath}: unexpected format`);
        return {};
      }
      logger.info(`Restored ${Object.keys(parsed.devices).length} last-seen timestamps`);
      return parsed.devices;
    } catch (err) {
      logger.warn(`Ignoring ${this.filePath}: invalid JSON`, err);
      return {};
    }
  }

  /**
   * Persist the last-seen map, atomically (write to a temporary file then
   * rename) so a container killed mid-write never leaves a truncated file.
   * @param {Record<string, {last_seen: number}>} devices - Map keyed by IEEE address.
   * @returns {Promise<boolean>} True when the write succeeded.
   */
  async save(devices) {
    const payload = JSON.stringify({ version: FILE_VERSION, devices });
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, payload, 'utf8');
      await rename(temporaryPath, this.filePath);
      this.writeFailureLogged = false;
      return true;
    } catch (err) {
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

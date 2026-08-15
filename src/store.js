// -----------------------------------------------------------------------------
// Persistence of the learned RFLink devices.
//
// WHY THIS EXISTS
// RFLink devices are not enumerable: a 433 MHz sensor is invisible until it
// decides to transmit, and a remote until someone presses its button. The
// integration therefore builds its device list by LISTENING. Without
// persistence, every restart would empty the Discovery screen until each
// device happens to talk again — up to an hour for a weather station, forever
// for a remote nobody presses.
//
// `/data` is the single writable volume of the integration container and is
// fully owned by us (the SDK persists nothing there), so that is where the
// learned devices live. Writes are debounced: RF chatter must not turn into
// disk churn.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const defaultLogger = createLogger({ name: 'store' });

/**
 * Directory of the persistent state. `/data` in the Gladys container;
 * overridable so a developer (and the test suite) can run outside Docker.
 */
export const DATA_DIR = process.env.RFLINK_DATA_DIR ?? '/data';

/** Full path of the learned-devices file. */
export const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

export class JsonStore {
  /**
   * @param {string} filePath - File backing the store.
   * @param {object} [options] - Options.
   * @param {object} [options.logger] - Logger, defaults to the SDK named logger.
   * @param {number} [options.writeDelayMs] - Debounce window for `scheduleWrite`.
   */
  constructor(filePath, { logger = defaultLogger, writeDelayMs = 2_000 } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.writeDelayMs = writeDelayMs;
    this.timer = null;
    this.pending = null;
  }

  /**
   * Read the stored value.
   *
   * A missing or corrupt file is NOT an error: it just means "nothing learned
   * yet". Refusing to start because a cache file is unreadable would be the
   * wrong trade — the integration relearns by listening.
   * @param {*} [fallback] - Value returned when there is nothing usable to read.
   * @returns {Promise<*>} The stored value, or the fallback.
   */
  async read(fallback = null) {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn(`Cannot read ${this.filePath} (${err.message}), starting empty`);
      }
      return fallback;
    }
  }

  /**
   * Write the value now, atomically (temp file + rename), so a container
   * killed mid-write never leaves a truncated JSON behind.
   * @param {*} value - JSON-serializable value.
   * @returns {Promise<boolean>} True when written, false when the disk refused.
   */
  async write(value) {
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
      return true;
    } catch (err) {
      // Losing the cache degrades the experience, it does not break the
      // integration: everything still works from memory until the restart.
      this.logger.warn(`Cannot persist ${this.filePath}: ${err.message}`);
      return false;
    }
  }

  /**
   * Ask for a write, coalescing the bursts. A busy RF environment produces
   * dozens of frames per minute; one disk write every `writeDelayMs` is
   * plenty.
   * @param {*} value - JSON-serializable value.
   */
  scheduleWrite(value) {
    this.pending = value;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const value = this.pending;
      this.pending = null;
      this.write(value).catch(() => {});
    }, this.writeDelayMs);
    this.timer.unref?.();
  }

  /**
   * Flush a pending debounced write immediately — called on shutdown, so the
   * devices learned in the last seconds survive the stop.
   * @returns {Promise<void>} Resolves once flushed.
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) {
      return;
    }
    const value = this.pending;
    this.pending = null;
    await this.write(value);
  }
}

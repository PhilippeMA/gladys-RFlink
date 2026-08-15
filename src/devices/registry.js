// -----------------------------------------------------------------------------
// The device registry: what the integration has HEARD on the air.
//
// Unlike a cloud or Zigbee integration, there is no device list to fetch: the
// registry is built frame by frame. Its jobs are
//   - turning a frame into a stable device identity (protocol + id + unit);
//   - remembering which measurements each device reports, so the Gladys device
//     grows the right features;
//   - producing the discovery payload and the state batches;
//   - routing a Gladys command back to the RF address it came from.
//
// Persistence lives in `store.js`; the SDK plumbing lives in `index.js`. This
// module only manipulates plain objects, which is what makes it unit-testable
// without a gateway and without a Gladys.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { fieldDescriptor, normalizeMeasurements, supportedLabels } from './featureMap.js';

const defaultLogger = createLogger({ name: 'registry' });

// A 433 MHz receiver hears the whole neighbourhood. Without a ceiling, a
// chatty environment (or a jamming device) would grow the registry until the
// Discovery screen is unusable and every publish times out.
export const MAX_DEVICES = 200;

// Storage format version, so a future change can migrate instead of guessing.
const STORE_VERSION = 1;

/** Param names carried by the created Gladys device. */
export const PARAMS = {
  PROTOCOL: 'RFLINK_PROTOCOL',
  ID: 'RFLINK_ID',
  UNIT: 'RFLINK_UNIT',
};

/**
 * Turn any RFLink token into something safe for an external id.
 * @param {string} value - Raw token, e.g. 'Oregon TempHygro'.
 * @returns {string} Slug, e.g. 'oregon-temphygro'.
 */
export function slug(value) {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/**
 * The registry key of a device: what makes two frames the SAME device.
 *
 * `SWITCH=` is part of the identity, not a measurement: the four buttons of a
 * remote share one `ID=` and differ only by their unit, and each of them is a
 * device of its own in Gladys.
 * @param {object} target - `{ protocol, id, unit }`.
 * @returns {string} The registry key.
 */
export function entryKey({ protocol, id, unit }) {
  return `${slug(protocol)}|${slug(id)}|${unit === null || unit === undefined ? '' : slug(unit)}`;
}

/**
 * Build the Gladys device external id of an RFLink target.
 * @param {object} gladys - The SDK instance (owns the `ext:<selector>:` prefix).
 * @param {object} target - `{ protocol, id, unit }`.
 * @returns {object} `{ device, feature(key) }`.
 */
export function externalIdsFor(gladys, { protocol, id, unit }) {
  const platformId = unit === null || unit === undefined ? slug(id) : `${slug(id)}-${slug(unit)}`;
  return gladys.externalIds(slug(protocol), platformId);
}

/**
 * Human-readable default name of a device, shown in the Discovery screen.
 * @param {object} target - `{ protocol, id, unit }`.
 * @returns {string} The name, e.g. 'NewKaku 000005 (unit 2)'.
 */
export function defaultName({ protocol, id, unit }) {
  return unit === null || unit === undefined
    ? `${protocol} ${id}`
    : `${protocol} ${id} (unit ${unit})`;
}

export class DeviceRegistry {
  /**
   * @param {object} options - Options.
   * @param {object} options.gladys - The SDK instance.
   * @param {object} options.store - The JsonStore backing the registry.
   * @param {object} [options.logger] - Logger, defaults to the SDK named logger.
   * @param {number} [options.maxDevices] - Ceiling on learned devices.
   */
  constructor({ gladys, store, logger = defaultLogger, maxDevices = MAX_DEVICES }) {
    this.gladys = gladys;
    this.store = store;
    this.logger = logger;
    this.maxDevices = maxDevices;
    this.entries = new Map();
    this.warnedFull = false;
  }

  /** Reload the learned devices from disk. */
  async load() {
    const stored = await this.store.read(null);
    this.entries = new Map();
    for (const entry of stored?.devices ?? []) {
      if (!entry?.protocol || !entry?.id) {
        continue;
      }
      this.entries.set(entryKey(entry), {
        protocol: entry.protocol,
        id: entry.id,
        unit: entry.unit ?? null,
        labels: Array.isArray(entry.labels) ? entry.labels : [],
        firstSeen: entry.firstSeen ?? new Date().toISOString(),
        lastSeen: entry.lastSeen ?? null,
      });
    }
    this.logger.info(`Loaded ${this.entries.size} known RFLink device(s)`);
  }

  /** Persist the learned devices (debounced by the store). */
  save() {
    this.store.scheduleWrite({ version: STORE_VERSION, devices: [...this.entries.values()] });
  }

  /** @returns {object[]} Every known device entry. */
  list() {
    return [...this.entries.values()];
  }

  /**
   * Record what a device frame just told us.
   *
   * Returns `changed: true` when the device gained a measurement it had never
   * reported before — an Oregon sensor whose first frame carried only TEMP and
   * whose next one adds HUM. That is a STRUCTURE change: Gladys shows an
   * "Update" button on the already-created device rather than silently
   * altering it, so the caller re-publishes the discovery payload.
   * @param {object} frame - A `device` frame from `parseFrame`.
   * @param {object} [options] - Options.
   * @param {boolean} [options.autoDiscover] - Whether unknown devices may be learned.
   * @returns {object} `{ entry, values, isNew, changed }`; `entry` is null when ignored.
   */
  learn(frame, { autoDiscover = true } = {}) {
    const target = { protocol: frame.protocol, id: frame.id, unit: frame.unit ?? null };
    const values = normalizeMeasurements(frame.values);
    const labels = supportedLabels(values);
    const key = entryKey(target);
    const known = this.entries.get(key);

    if (!known) {
      if (!autoDiscover) {
        this.logger.debug(`Ignored unknown device ${key} (auto-discovery is off)`);
        return { entry: null, values, isNew: false, changed: false };
      }
      if (labels.length === 0) {
        // Nothing we can expose: creating a device with zero feature would
        // only clutter the Discovery screen.
        this.logger.debug(`Ignored ${key}: no supported measurement in ${JSON.stringify(values)}`);
        return { entry: null, values, isNew: false, changed: false };
      }
      if (this.entries.size >= this.maxDevices) {
        if (!this.warnedFull) {
          this.warnedFull = true;
          this.logger.warn(
            `Reached the ceiling of ${this.maxDevices} learned devices: new ones are ignored.` +
              ' Turn auto-discovery off once your devices are added, or ignore the noisy protocols.',
          );
        }
        return { entry: null, values, isNew: false, changed: false };
      }
      const now = new Date().toISOString();
      const entry = { ...target, labels, firstSeen: now, lastSeen: now };
      this.entries.set(key, entry);
      this.logger.info(`New RFLink device: ${defaultName(target)} [${labels.join(', ')}]`);
      this.save();
      return { entry, values, isNew: true, changed: false };
    }

    const newLabels = labels.filter((label) => !known.labels.includes(label));
    known.lastSeen = new Date().toISOString();
    if (newLabels.length > 0) {
      known.labels = [...known.labels, ...newLabels];
      this.logger.info(`${defaultName(known)} gained: ${newLabels.join(', ')}`);
    }
    this.save();
    return { entry: known, values, isNew: false, changed: newLabels.length > 0 };
  }

  /**
   * Forget every learned device the user has NOT created in Gladys.
   *
   * The escape hatch for a noisy neighbourhood: the Discovery screen filled up
   * with someone else's sensors, and re-learning only what matters is one
   * click away.
   * @param {string[]} keptExternalIds - External ids to preserve (created devices).
   * @returns {number} How many entries were dropped.
   */
  forgetUncreated(keptExternalIds = []) {
    const kept = new Set(keptExternalIds);
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (!kept.has(externalIdsFor(this.gladys, entry).device)) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.save();
    }
    return dropped;
  }

  /**
   * Find the RFLink address behind a Gladys device external id.
   *
   * Falls back to the params of the device created in Gladys: they carry the
   * protocol / id / unit, so a command still works after the `/data` cache was
   * lost (a recreated container, a wiped volume).
   * @param {string} externalId - Gladys device external_id.
   * @param {object[]} [createdDevices] - `gladys.devices`, for the fallback.
   * @returns {object|null} `{ protocol, id, unit, labels }` or null.
   */
  resolve(externalId, createdDevices = []) {
    for (const entry of this.entries.values()) {
      if (externalIdsFor(this.gladys, entry).device === externalId) {
        return entry;
      }
    }

    const device = createdDevices.find((candidate) => candidate.external_id === externalId);
    const params = device?.params ?? [];
    const read = (name) => params.find((param) => param.name === name)?.value;
    const protocol = read(PARAMS.PROTOCOL);
    const id = read(PARAMS.ID);
    if (!protocol || !id) {
      return null;
    }
    const unit = read(PARAMS.UNIT);
    this.logger.info(`Recovered ${protocol} ${id} from its Gladys params (cache was empty)`);
    return { protocol, id, unit: unit === undefined || unit === '' ? null : unit, labels: [] };
  }

  /**
   * Build the discovery payload: every device we know about.
   *
   * `publishDiscoveredDevices` replaces the previous list and silently upserts
   * the params of the devices the user already created, so publishing the
   * whole registry is both the discovery answer and the refresh path.
   * @returns {object[]} Devices, in the SDK discovery format.
   */
  buildDiscoveredDevices() {
    return this.list().map((entry) => this.buildDevice(entry));
  }

  /**
   * Build the Gladys device payload of one entry.
   * @param {object} entry - A registry entry.
   * @returns {object} The device payload.
   */
  buildDevice(entry) {
    const ids = externalIdsFor(this.gladys, entry);
    const params = [
      { name: PARAMS.PROTOCOL, value: entry.protocol },
      { name: PARAMS.ID, value: entry.id },
    ];
    if (entry.unit !== null && entry.unit !== undefined) {
      params.push({ name: PARAMS.UNIT, value: String(entry.unit) });
    }

    return {
      name: defaultName(entry),
      external_id: ids.device,
      params,
      features: entry.labels
        .map((label) => {
          const descriptor = fieldDescriptor(label, entry.labels);
          if (!descriptor) {
            return null;
          }
          return {
            name: descriptor.name,
            external_id: ids.feature(descriptor.key),
            category: descriptor.category,
            type: descriptor.type,
            ...(descriptor.unit ? { unit: descriptor.unit } : {}),
            min: descriptor.min,
            max: descriptor.max,
            read_only: descriptor.read_only ?? true,
            // 433 MHz is one-way and unacknowledged: the gateway transmits and
            // hopes. Claiming feedback we cannot provide would leave Gladys
            // waiting for a confirmation that never comes.
            has_feedback: false,
            keep_history: true,
          };
        })
        .filter((feature) => feature !== null),
    };
  }

  /**
   * Turn the measurements of a frame into a Gladys state batch.
   * @param {object} entry - The registry entry of the device.
   * @param {Record<string, string>} values - Normalized measurements.
   * @returns {object[]} States, ready for `publishStates`.
   */
  buildStates(entry, values) {
    const ids = externalIdsFor(this.gladys, entry);
    const states = [];
    for (const [label, raw] of Object.entries(values)) {
      const descriptor = fieldDescriptor(label, entry.labels);
      if (!descriptor) {
        continue;
      }
      const state = descriptor.decode(raw);
      if (state === null || Number.isNaN(state)) {
        this.logger.debug(`Undecodable ${label}='${raw}' on ${defaultName(entry)}`);
        continue;
      }
      states.push({ device_feature_external_id: ids.feature(descriptor.key), state });
    }
    return states;
  }
}

// -----------------------------------------------------------------------------
// The two directions of traffic, in one testable place.
//
//   radio -> Gladys : an RFLink frame becomes learned devices and published
//                     states (`handleFrame`);
//   Gladys -> radio : a user command becomes an RFLink command line
//                     (`handleSetValue`).
//
// This lives outside `index.js` on purpose: `index.js` self-executes (it
// connects to Gladys on import), so anything it holds cannot be unit-tested.
// Everything here is injected — the SDK, the registry, the gateway, the
// configuration — which is what makes the whole path exercisable without a
// gateway and without a Gladys.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { buildProtocolFilter } from './config.js';
import { controllableLabel, percentToLevel } from './devices/featureMap.js';
import { externalIdsFor } from './devices/registry.js';
import { buildDeviceCommand, FRAME_KINDS } from './rflink/protocol.js';

const defaultLogger = createLogger({ name: 'pipeline' });

// Most RF protocols transmit the same packet 2 to 4 times in a row so that a
// receiver catches at least one. Publishing each repeat would triple the
// history for nothing.
export const DUPLICATE_WINDOW_MS = 1_000;

/**
 * Translate a Gladys command into the RFLink command word.
 * @param {string} featureKey - Feature key, e.g. 'cmd' or 'brightness'.
 * @param {number} value - The value Gladys asked for.
 * @returns {string|null} The RFLink command, or null for a read-only feature.
 */
export function commandFor(featureKey, value) {
  switch (controllableLabel(featureKey)) {
    case 'CMD':
      return Number(value) === 0 ? 'OFF' : 'ON';
    case 'SET_LEVEL':
      // RFLink dimmers take the level (0-15) as the command word itself.
      return String(percentToLevel(Number(value)));
    default:
      return null;
  }
}

/**
 * Build the traffic handlers.
 *
 * The configuration and the gateway are passed as GETTERS: the user can change
 * the address or the ignore list at any time, and the handlers registered at
 * startup must act on the current values.
 * @param {object} deps - Dependencies.
 * @param {object} deps.gladys - The SDK instance.
 * @param {object} deps.registry - The device registry.
 * @param {Function} deps.getConfig - `() => normalized config`.
 * @param {Function} deps.getGateway - `() => RflinkGateway | null`.
 * @param {Function} deps.onDevicesChanged - Called when the discovery payload is stale.
 * @param {object} [deps.logger] - Logger, defaults to the SDK named logger.
 * @returns {object} `{ handleFrame, handleSetValue }`.
 */
export function createPipeline({
  gladys,
  registry,
  getConfig,
  getGateway,
  onDevicesChanged,
  logger = defaultLogger,
}) {
  const lastFrames = new Map();

  // The ignore list is a comma-separated string in the configuration; rebuild
  // the matcher only when that string actually changes, not on every frame.
  let filterSource = null;
  let matchesIgnored = () => false;

  /**
   * @param {object} config - The current configuration.
   * @returns {Function} `(protocol) => boolean`.
   */
  function protocolFilter(config) {
    if (config.ignored_protocols !== filterSource) {
      filterSource = config.ignored_protocols;
      matchesIgnored = buildProtocolFilter(config);
    }
    return matchesIgnored;
  }

  /**
   * Whether this exact frame was already handled a moment ago.
   * @param {object} frame - A device frame.
   * @returns {boolean} True when it is a radio repeat of the previous one.
   */
  function isDuplicate(frame) {
    const key = `${frame.protocol}|${frame.id}|${frame.unit}`;
    const signature = JSON.stringify(frame.values);
    const now = Date.now();
    const previous = lastFrames.get(key);
    lastFrames.set(key, { signature, at: now });
    return (
      previous !== undefined &&
      previous.signature === signature &&
      now - previous.at < DUPLICATE_WINDOW_MS
    );
  }

  /**
   * Whether the user has created this device in Gladys.
   * @param {object} entry - A registry entry.
   * @returns {boolean} True when a matching device exists.
   */
  function isCreated(entry) {
    const externalId = externalIdsFor(gladys, entry).device;
    // The SDK keeps `gladys.devices` in sync through the device-created /
    // updated / deleted events, so this stays accurate without polling.
    return (gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  return {
    /**
     * Handle one frame coming from the gateway.
     * @param {object} frame - A frame from `parseFrame`.
     */
    async handleFrame(frame) {
      if (frame.kind === FRAME_KINDS.BANNER) {
        logger.info(`RFLink gateway ready: ${frame.message}`);
        return;
      }
      if (frame.kind !== FRAME_KINDS.DEVICE) {
        return; // OK / PONG / VERSION are consumed by `gateway.request()`.
      }

      const config = getConfig();
      if (protocolFilter(config)(frame.protocol)) {
        logger.debug(`Ignored protocol ${frame.protocol}`);
        return;
      }
      if (isDuplicate(frame)) {
        return;
      }

      const { entry, values, isNew, changed } = registry.learn(frame, {
        autoDiscover: config.auto_discover,
      });
      if (!entry) {
        return;
      }

      // A structure change (a sensor that starts reporting humidity too) or a
      // brand new device has to reach the Discovery screen.
      if (isNew || changed) {
        onDevicesChanged();
      }

      // States are only worth publishing for devices the user actually
      // created: everything else would be a rejected HTTP call per frame.
      if (!isCreated(entry)) {
        return;
      }
      const states = registry.buildStates(entry, values);
      if (states.length > 0) {
        await gladys.publishStates(states);
      }
    },

    /**
     * Handle a command the user triggered in Gladys.
     *
     * Nothing is published back: these features declare `has_feedback: false`
     * because 433 MHz is one-way, so Gladys records the requested value
     * itself. Throwing acks the command as failed, which is what the user
     * needs to see when the gateway is down.
     * @param {object} device - The Gladys device.
     * @param {object} feature - The Gladys feature.
     * @param {number} value - The requested value.
     */
    async handleSetValue(device, feature, value) {
      const target = registry.resolve(device.external_id, gladys.devices ?? []);
      if (!target) {
        throw new Error(`Unknown RFLink device ${device.external_id}`);
      }
      const gateway = getGateway();
      if (!gateway) {
        throw new Error('No RFLink gateway configured');
      }

      // The feature external_id is `<device external_id>:<feature key>`.
      const featureKey = feature.external_id.slice(device.external_id.length + 1);
      const command = commandFor(featureKey, value);
      if (command === null) {
        throw new Error(`Feature ${featureKey} cannot be controlled`);
      }

      const line = buildDeviceCommand(target, command);
      logger.info(`Gladys -> RFLink: ${line}`);
      await gateway.send(line);
    },
  };
}

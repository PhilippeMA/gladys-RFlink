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
import { controllableLabel, percentToLevel, RFLINK_FIELDS } from './devices/featureMap.js';
import { externalIdsFor } from './devices/registry.js';
import { encodeRoleCommand, pulseSecondsFor } from './devices/roles.js';
import { buildDeviceCommand, FRAME_KINDS } from './rflink/protocol.js';

const defaultLogger = createLogger({ name: 'pipeline' });

// Most RF protocols transmit the same packet 2 to 4 times in a row so that a
// receiver catches at least one. Publishing each repeat would triple the
// history for nothing.
export const DUPLICATE_WINDOW_MS = 1_000;

// A reading older than this is not replayed when the device is created: a
// temperature from last week says nothing about the room now.
export const REPLAY_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/**
 * Translate a Gladys command into the RFLink command word.
 *
 * The device's ROLE decides the vocabulary: a shutter answers UP/DOWN/STOP
 * where a plug answers ON/OFF, and both ride on the same `CMD` field.
 * @param {object} entry - The registry entry of the device.
 * @param {string} featureKey - Feature key, e.g. 'cmd' or 'brightness'.
 * @param {number} value - The value Gladys asked for.
 * @returns {string|null} The RFLink command, or null when it cannot be sent.
 */
export function commandFor(entry, featureKey, value) {
  switch (controllableLabel(featureKey)) {
    case 'CMD': {
      const roleCommand = encodeRoleCommand(entry?.role, value);
      // `undefined` means the role has no vocabulary of its own; `null` means
      // it has one and this value is not in it — which must not silently fall
      // back to ON.
      return roleCommand === undefined ? (Number(value) === 0 ? 'OFF' : 'ON') : roleCommand;
    }
    case 'SET_LEVEL': {
      // RFLink dimmers take the level as the command word itself, and the
      // reference documents the transmit range as "1 to 15" — 0 is not a dim
      // level. A brightness of zero is the user switching the light off.
      const level = percentToLevel(Number(value));
      return level === 0 ? 'OFF' : String(level);
    }
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
 * @param {number} [deps.duplicateWindowMs] - Window in which an identical frame is a radio repeat.
 * @returns {object} `{ handleFrame, handleSetValue, handleDeviceKnown, stop }`.
 */
export function createPipeline({
  gladys,
  registry,
  getConfig,
  getGateway,
  onDevicesChanged,
  logger = defaultLogger,
  duplicateWindowMs = DUPLICATE_WINDOW_MS,
}) {
  const lastFrames = new Map();

  // Last reading heard per device, INCLUDING for devices the user has not
  // created yet — that is the whole point: an RF device is heard long before
  // it is added, and without this its features would sit empty until it next
  // transmits (minutes for a weather sensor, never for a remote).
  const lastStates = new Map();

  // Pending "back to 0" of the pulsed sensors, keyed by feature external id.
  const resetTimers = new Map();

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
      now - previous.at < duplicateWindowMs
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

  /**
   * Arm the automatic return to 0 of a pulsed sensor.
   *
   * A PIR sends ON on detection and, on most cheap hardware, never sends OFF.
   * Left alone the feature stays at 1 for ever: no further transition, so no
   * scene can ever re-trigger. Each new detection re-arms the delay rather
   * than stacking a second timer.
   * @param {object} entry - The registry entry of the device.
   * @param {object[]} states - The states just published.
   */
  function armPulseReset(entry, states) {
    const seconds = pulseSecondsFor(entry);
    if (seconds === null) {
      return;
    }
    const featureId = externalIdsFor(gladys, entry).feature(RFLINK_FIELDS.CMD.key);
    const detection = states.find(
      (state) => state.device_feature_external_id === featureId && state.state === 1,
    );
    if (!detection) {
      return;
    }

    clearTimeout(resetTimers.get(featureId));
    const timer = setTimeout(() => {
      resetTimers.delete(featureId);
      gladys
        .publishState(featureId, 0)
        .catch((err) => logger.error(`Pulse reset failed for ${featureId}`, err));
    }, seconds * 1_000);
    timer.unref?.();
    resetTimers.set(featureId, timer);
  }

  /**
   * Remember the reading, and publish it when the device exists in Gladys.
   * @param {object} entry - The registry entry of the device.
   * @param {object[]} states - The states built from the frame.
   */
  async function publishStates(entry, states) {
    if (states.length === 0) {
      return;
    }
    lastStates.set(externalIdsFor(gladys, entry).device, { states, at: Date.now() });
    if (!isCreated(entry)) {
      // Publishing for a device the user has not added would be a rejected
      // HTTP call on every single frame.
      return;
    }
    await gladys.publishStates(states);
    armPulseReset(entry, states);
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

      await publishStates(entry, registry.buildStates(entry, values));
    },

    /**
     * Replay the last known reading onto a device that just appeared, or whose
     * feature list the user just updated.
     *
     * Without this, adding a sensor from the Discovery screen gives a device
     * whose features are BLANK until it next transmits — up to several minutes
     * on a weather sensor, and indefinitely on a remote nobody presses. We
     * already heard the value: it only has to be handed over, timestamped when
     * it was actually measured rather than passed off as current.
     * @param {object} device - The Gladys device that was created or updated.
     */
    async handleDeviceKnown(device) {
      const remembered = lastStates.get(device.external_id);
      if (!remembered) {
        return;
      }
      const age = Date.now() - remembered.at;
      if (age > REPLAY_MAX_AGE_MS) {
        logger.debug(`Not replaying a ${Math.round(age / 60_000)} min old reading`);
        return;
      }

      const entry = registry.resolve(device.external_id, gladys.devices ?? []);
      // A pulsed sensor reports an EVENT, not a state: replaying "motion
      // detected" from ten minutes ago would light up a detector that has been
      // quiet since.
      const isPulsed = entry !== null && pulseSecondsFor(entry) !== null;
      const cmdFeatureId =
        entry === null ? null : externalIdsFor(gladys, entry).feature(RFLINK_FIELDS.CMD.key);
      const states = remembered.states
        .filter((state) => !(isPulsed && state.device_feature_external_id === cmdFeatureId))
        .map((state) => ({ ...state, created_at: new Date(remembered.at).toISOString() }));

      if (states.length === 0) {
        return;
      }
      logger.info(`Replaying the last known reading of ${device.external_id}`);
      await gladys.publishStates(states);
    },

    /** Drop the pending pulse resets (disconnection, shutdown). */
    stop() {
      for (const timer of resetTimers.values()) {
        clearTimeout(timer);
      }
      resetTimers.clear();
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
      const command = commandFor(target, featureKey, value);
      if (command === null) {
        throw new Error(`Feature ${featureKey} cannot be controlled with value ${value}`);
      }

      const line = buildDeviceCommand(target, command);
      logger.info(`Gladys -> RFLink: ${line}`);
      await gateway.send(line);
    },
  };
}

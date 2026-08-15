// -----------------------------------------------------------------------------
// Device roles: what a switch-like frame ACTUALLY is.
//
// THE PROBLEM THIS SOLVES
// EV1527, PT2262, HS1527 and friends are bare OOK encoder chips: they transmit
// 20 bits of address plus 4 bits of data, and nothing else. The same chip sits
// in motion detectors, door contacts, smoke alarms, leak probes, doorbell
// buttons, panic buttons and cheap relay receivers — and every one of them
// produces the exact same frame:
//
//   20;2D;EV1527;ID=07a410;SWITCH=01;CMD=ON;
//
// No decoder can tell them apart, because the information is not on the air.
// It has to come from the user, once per device, and that is what this module
// carries: a role overrides the Gladys category/type of the `CMD` feature.
//
// TWO THINGS A ROLE DECIDES
//   1. the category/type/read_only of the feature (a PIR is not an actuator);
//   2. whether the sensor is PULSED — a motion detector sends ON on detection
//      and usually never sends OFF, so without an automatic reset the feature
//      stays at 1 for ever, no transition ever happens again, and no scene can
//      re-trigger. `pulseSeconds` is what makes such a device usable.
//
// The feature KEY never changes with the role (it stays `cmd`), so re-typing a
// device keeps the history it has already recorded.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

/** The role every device starts with: what RFLink reports, taken literally. */
export const DEFAULT_ROLE = 'switch';

// Gladys drives a cover with three values (COVER_STATE in the core), and
// Somfy RTS speaks the same three words on the air. This is the whole
// translation.
const COVER = { OPEN: 1, STOP: 0, CLOSE: -1 };

const COVER_FROM_RFLINK = { UP: COVER.OPEN, DOWN: COVER.CLOSE, STOP: COVER.STOP };
const RFLINK_FROM_COVER = { [COVER.OPEN]: 'UP', [COVER.CLOSE]: 'DOWN', [COVER.STOP]: 'STOP' };

/**
 * The RFLink command words that mean "this is a cover, not a switch".
 *
 * Unlike an EV1527 chip, a frame carrying UP/DOWN/STOP states its own device
 * class: `20;1E;RTS;ID=f1e260;SWITCH=01;CMD=DOWN;` cannot be anything but a
 * shutter, an awning or a curtain. Reading it is not guessing.
 */
export const COVER_COMMANDS = Object.keys(COVER_FROM_RFLINK);

const coverBehaviour = {
  controllable: true,
  pulseSeconds: null,
  min: COVER.CLOSE,
  max: COVER.OPEN,
  decode: (raw) => COVER_FROM_RFLINK[String(raw).toUpperCase()] ?? null,
  encode: (value) => RFLINK_FROM_COVER[Number(value)] ?? null,
};

/**
 * The role catalog.
 *
 * `controllable` : the user can act on it (an actuator), otherwise read-only;
 * `pulseSeconds` : default delay before the state is reset to 0, `null` for a
 *                  device that reports both ON and OFF by itself.
 */
export const DEVICE_ROLES = {
  switch: {
    name: 'On/Off',
    category: CATEGORIES.SWITCH,
    type: TYPES.SWITCH.BINARY,
    controllable: true,
    pulseSeconds: null,
  },
  light: {
    name: 'On/Off',
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.BINARY,
    controllable: true,
    pulseSeconds: null,
  },
  shutter: {
    name: 'Shutter',
    category: CATEGORIES.SHUTTER,
    type: TYPES.SHUTTER.STATE,
    ...coverBehaviour,
  },
  curtain: {
    name: 'Curtain',
    category: CATEGORIES.CURTAIN,
    type: TYPES.CURTAIN.STATE,
    ...coverBehaviour,
  },
  siren: {
    name: 'Siren',
    category: CATEGORIES.SIREN,
    type: TYPES.SIREN.BINARY,
    controllable: true,
    pulseSeconds: null,
  },
  motion: {
    name: 'Motion',
    category: CATEGORIES.MOTION_SENSOR,
    type: TYPES.SENSOR.BINARY,
    controllable: false,
    pulseSeconds: 60,
  },
  presence: {
    name: 'Presence',
    category: CATEGORIES.PRESENCE_SENSOR,
    type: TYPES.SENSOR.BINARY,
    controllable: false,
    pulseSeconds: 60,
  },
  opening: {
    name: 'Opening',
    category: CATEGORIES.OPENING_SENSOR,
    type: TYPES.SENSOR.BINARY,
    controllable: false,
    // A reed contact transmits on both open AND close: resetting it would
    // erase a door that is genuinely still open.
    pulseSeconds: null,
  },
  smoke: {
    name: 'Smoke',
    category: CATEGORIES.SMOKE_SENSOR,
    type: TYPES.SENSOR.BINARY,
    controllable: false,
    pulseSeconds: 60,
  },
  leak: {
    name: 'Leak',
    category: CATEGORIES.LEAK_SENSOR,
    type: TYPES.SENSOR.BINARY,
    controllable: false,
    pulseSeconds: 60,
  },
  vibration: {
    name: 'Vibration',
    category: CATEGORIES.VIBRATION_SENSOR,
    type: TYPES.VIBRATION_SENSOR.BINARY,
    controllable: false,
    pulseSeconds: 30,
  },
  doorbell: {
    name: 'Ring',
    category: CATEGORIES.DOORBELL,
    type: TYPES.DOORBELL.RING,
    controllable: false,
    pulseSeconds: 2,
  },
  button: {
    name: 'Button',
    category: CATEGORIES.BUTTON,
    type: TYPES.BUTTON.CLICK,
    controllable: false,
    pulseSeconds: 2,
  },
  input: {
    // The honest "it is not an actuator, and I do not know more than that".
    name: 'Contact',
    category: CATEGORIES.INPUT,
    type: TYPES.INPUT.BINARY,
    controllable: false,
    pulseSeconds: null,
  },
};

/** @returns {string[]} Every valid role key. */
export function roleKeys() {
  return Object.keys(DEVICE_ROLES);
}

/**
 * @param {string} [role] - A role key.
 * @returns {boolean} Whether the key is part of the catalog.
 */
export function isKnownRole(role) {
  return typeof role === 'string' && role in DEVICE_ROLES;
}

/**
 * Apply a device role to the descriptor of one RFLink field.
 *
 * Only the `CMD` field is re-typed: a role says what the switch-like signal
 * means, it never touches a temperature or a battery level reported by the
 * same device.
 * @param {object} descriptor - The protocol-level descriptor from featureMap.
 * @param {string} label - The RFLink field label.
 * @param {string} [role] - The role of the device.
 * @returns {object} The descriptor to build the Gladys feature from.
 */
export function applyRole(descriptor, label, role) {
  if (label !== 'CMD' || !isKnownRole(role) || role === DEFAULT_ROLE) {
    return descriptor;
  }
  const spec = DEVICE_ROLES[role];
  return {
    ...descriptor,
    name: spec.name,
    category: spec.category,
    type: spec.type,
    read_only: !spec.controllable,
    // A cover does not just look different from a switch, it speaks a
    // different vocabulary: UP/DOWN/STOP on the air, -1/0/1 in Gladys. A role
    // may therefore replace the range and the decoder too.
    ...(spec.min === undefined ? {} : { min: spec.min }),
    ...(spec.max === undefined ? {} : { max: spec.max }),
    ...(spec.decode === undefined ? {} : { decode: spec.decode }),
  };
}

/**
 * Turn a Gladys command value into the RFLink command word, for a role that
 * does not speak ON/OFF.
 * @param {string} [role] - The role of the device.
 * @param {number} value - The value Gladys asked for.
 * @returns {string|null|undefined} The command word, null when the value is out
 *   of range, undefined when the role has no vocabulary of its own.
 */
export function encodeRoleCommand(role, value) {
  if (!isKnownRole(role) || DEVICE_ROLES[role].encode === undefined) {
    return undefined;
  }
  return DEVICE_ROLES[role].encode(value);
}

/**
 * Guess the role of a device from what its frame actually says.
 *
 * This is NOT the EV1527 problem: a `CMD=UP` is a device class stated on the
 * air, so honouring it is reading, not inferring. Anything else keeps the
 * default and waits for the user to declare it.
 * @param {Record<string, string>} values - Normalized measurements of a frame.
 * @returns {string|null} The role the frame implies, or null.
 */
export function roleFromFrame(values = {}) {
  // UP, DOWN and STOP are all cover-only vocabulary in RFLink: no switch, no
  // remote and no sensor emits them.
  const command = String(values.CMD ?? '').toUpperCase();
  return COVER_COMMANDS.includes(command) ? 'shutter' : null;
}

/**
 * How long a device stays "on" after a detection, before we reset it to 0.
 *
 * The per-device value wins; `0` disables the reset (the user drives it from a
 * scene); `null`/`undefined` falls back to the default of the role.
 * @param {object} entry - A registry entry.
 * @returns {number|null} Delay in seconds, or null when there is no reset.
 */
export function pulseSecondsFor(entry) {
  if (!isKnownRole(entry?.role)) {
    return null;
  }
  const configured = entry.resetAfter;
  if (configured === 0) {
    return null;
  }
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEVICE_ROLES[entry.role].pulseSeconds;
}

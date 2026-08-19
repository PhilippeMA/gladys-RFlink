// -----------------------------------------------------------------------------
// RFLink data field -> Gladys device feature.
//
// An RFLink frame is a bag of labelled measurements:
//
//   20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;BAT=OK;
//
// Each label becomes ONE Gladys feature of the device. This table is the whole
// translation layer: the category/type/unit Gladys should use, and how to turn
// the raw field into a number. Adding support for a new RFLink measurement is
// adding one entry here — nothing else in the codebase needs to change.
//
// The reference is the official RFLink protocol documentation. Its own wording
// decides the decoding: a field it documents as "hexadecimal" is read as hex,
// the others as plain decimal. Getting that backwards is the classic source of
// absurd values (a temperature of 180 instead of 18.0).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';

import { parseDecimal, parseHex, parseSignedTemperature } from '../rflink/protocol.js';

/** RFLink dim levels run from 0 to 15; Gladys brightness is a percentage. */
export const MAX_DIM_LEVEL = 15;

/** RFLink wind direction is one of 16 sectors of 22.5 degrees. */
const DEGREES_PER_WIND_SECTOR = 360 / 16;

/**
 * Convert an RFLink dim level (0-15) to a Gladys brightness percentage.
 * @param {number} level - RFLink level.
 * @returns {number} Percentage, 0-100.
 */
export function levelToPercent(level) {
  return Math.round((Math.max(0, Math.min(MAX_DIM_LEVEL, level)) / MAX_DIM_LEVEL) * 100);
}

/**
 * Convert a Gladys brightness percentage to an RFLink dim level (0-15).
 * @param {number} percent - Percentage, 0-100.
 * @returns {number} RFLink level.
 */
export function percentToLevel(percent) {
  return Math.round((Math.max(0, Math.min(100, percent)) / 100) * MAX_DIM_LEVEL);
}

const onOff = (raw) => {
  const value = String(raw).toUpperCase();
  if (value === 'ON' || value === 'ALLON') {
    return 1;
  }
  if (value === 'OFF' || value === 'ALLOFF') {
    return 0;
  }
  return null;
};

// Hexadecimal field expressed in tenths of a unit (rain, wind speed...).
const hexTenth = (raw) => {
  const value = parseHex(raw);
  return value === null ? null : Number((value / 10).toFixed(1));
};

// Fields RFLink reports that deliberately get NO feature.
//
// Both are values the sensor DERIVES from another field it already sends, on a
// scale no Gladys category carries. Mapping them to the `unknown` category —
// which is what a first version did — produces a feature with no name and no
// icon: a blank line in the user's device, next to the humidity it is computed
// from. A redundant reading is not worth a feature nobody can read.
//
//   HSTATUS   0-3, bucketed from HUM  (normal / comfortable / dry / wet)
//   BFORECAST 0-4, trend of BARO      (sunny / partly cloudy / cloudy / rain)
//
// They can come back the day Gladys has somewhere sensible to put them.
export const IGNORED_FIELDS = ['HSTATUS', 'BFORECAST'];

/**
 * The translation table, keyed by the RFLink field label.
 *
 * `key`      : suffix of the Gladys feature external_id — NEVER change one of
 *              these, it would orphan the history of every existing device;
 * `decode`   : raw field -> the number Gladys stores, or null to skip it;
 * `command`  : present on controllable fields only (see `registry.js`).
 */
export const RFLINK_FIELDS = {
  // --- Actuators -------------------------------------------------------------
  CMD: {
    key: 'cmd',
    name: 'On/Off',
    category: CATEGORIES.SWITCH,
    type: TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    decode: onOff,
  },
  SET_LEVEL: {
    key: 'brightness',
    name: 'Brightness',
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.BRIGHTNESS,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    read_only: false,
    decode: (raw) => {
      const level = parseDecimal(raw);
      return level === null ? null : levelToPercent(level);
    },
  },

  // --- Climate ---------------------------------------------------------------
  TEMP: {
    key: 'temperature',
    name: 'Temperature',
    category: CATEGORIES.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -50,
    max: 70,
    decode: parseSignedTemperature,
  },
  HUM: {
    key: 'humidity',
    name: 'Humidity',
    category: CATEGORIES.HUMIDITY_SENSOR,
    // DECIMAL even though RFLink only ever sends whole percents: Gladys
    // resolves a feature's icon and its translated label by the exact
    // (category, type) pair, and `humidity-sensor` is only registered with
    // `decimal`. With `integer` the value still arrives, but the droplet icon
    // falls back to a generic slider and the label to the raw feature name.
    // See CATEGORY_TYPE_CONTRACT in test/featureMap.test.js.
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    decode: parseDecimal,
  },
  BARO: {
    key: 'pressure',
    name: 'Pressure',
    category: CATEGORIES.PRESSURE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.HECTO_PASCAL,
    min: 800,
    max: 1200,
    decode: parseHex,
  },
  // --- Weather station -------------------------------------------------------
  RAIN: {
    key: 'rain-total',
    name: 'Rain total',
    category: CATEGORIES.PRECIPITATION_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.MM,
    min: 0,
    max: 1000,
    decode: hexTenth,
  },
  RAINRATE: {
    key: 'rain-rate',
    name: 'Rain rate',
    category: CATEGORIES.PRECIPITATION_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.MILLIMETER_PER_HOUR,
    min: 0,
    max: 500,
    decode: hexTenth,
  },
  WINSP: {
    key: 'wind-speed',
    name: 'Wind speed',
    category: CATEGORIES.SPEED_SENSOR,
    type: TYPES.SPEED_SENSOR.DECIMAL,
    unit: UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 300,
    decode: hexTenth,
  },
  AWINSP: {
    key: 'wind-speed-average',
    name: 'Average wind speed',
    category: CATEGORIES.SPEED_SENSOR,
    type: TYPES.SPEED_SENSOR.DECIMAL,
    unit: UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 300,
    decode: hexTenth,
  },
  WINGS: {
    key: 'wind-gust',
    name: 'Wind gust',
    category: CATEGORIES.SPEED_SENSOR,
    type: TYPES.SPEED_SENSOR.DECIMAL,
    unit: UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 300,
    // The reference text says "hexadecimal" WITHOUT the "needs division by 10"
    // it attaches to WINSP and AWINSP — but its own sample contradicts it:
    //   20;47;Cresta;ID=8001;WINDIR=0002;WINSP=0060;WINGS=0088;
    // 0x60 = 96 -> 9.6 km/h of wind, and 0x88 = 136 would be a 136 km/h gust.
    // A gust fourteen times the wind is not weather; 13.6 km/h is. The
    // documentation is incomplete here, so the division stays.
    decode: hexTenth,
  },
  WINDIR: {
    key: 'wind-direction',
    name: 'Wind direction',
    category: CATEGORIES.ANGLE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.DEGREE,
    min: 0,
    max: 359,
    // The reference says "integer value from 0-15" reflecting 22.5 degree
    // steps, but writes the value hexadecimally like every other measurement
    // (`WINDIR=0005`, and `WINDIR=5A` in the UPM/Esic sample). Read it as hex:
    // it is identical for a real sector, and it stops silently dropping the
    // frames a decimal-only reader cannot parse.
    decode: (raw) => {
      const sector = parseHex(raw);
      if (sector === null) {
        return null;
      }
      if (sector > 15) {
        // Out of the documented range: refuse rather than invent a bearing.
        // Surfacing it is how the real meaning gets reported and fixed.
        return null;
      }
      return Math.round(sector * DEGREES_PER_WIND_SECTOR) % 360;
    },
  },
  WINCHL: {
    key: 'wind-chill',
    name: 'Wind chill',
    category: CATEGORIES.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -50,
    max: 70,
    decode: parseSignedTemperature,
  },
  WINTMP: {
    key: 'wind-temperature',
    name: 'Wind meter temperature',
    category: CATEGORIES.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -50,
    max: 70,
    decode: parseSignedTemperature,
  },
  UV: {
    key: 'uv',
    name: 'UV index',
    category: CATEGORIES.UV_SENSOR,
    type: TYPES.UV_SENSOR.INTEGER,
    unit: UNITS.UV_INDEX,
    min: 0,
    max: 20,
    decode: parseHex,
  },
  LUX: {
    key: 'luminosity',
    name: 'Luminosity',
    category: CATEGORIES.LIGHT_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.LUX,
    min: 0,
    max: 100_000,
    decode: parseHex,
  },

  // --- Security --------------------------------------------------------------
  PIR: {
    key: 'motion',
    name: 'Motion',
    category: CATEGORIES.MOTION_SENSOR,
    type: TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    decode: onOff,
  },
  SMOKEALERT: {
    key: 'smoke',
    name: 'Smoke',
    category: CATEGORIES.SMOKE_SENSOR,
    type: TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    decode: onOff,
  },
  CHIME: {
    key: 'chime',
    name: 'Chime',
    category: CATEGORIES.DOORBELL,
    type: TYPES.DOORBELL.RING,
    min: 0,
    max: 255,
    decode: parseDecimal,
  },

  // --- Air quality -----------------------------------------------------------
  CO2: {
    key: 'co2',
    name: 'CO2',
    category: CATEGORIES.CO2_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.PPM,
    min: 0,
    max: 5000,
    decode: parseDecimal,
  },
  SOUND: {
    key: 'sound',
    name: 'Noise level',
    category: CATEGORIES.NOISE_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.DECIBEL,
    min: 0,
    max: 200,
    decode: parseDecimal,
  },

  // --- Energy ----------------------------------------------------------------
  WATT: {
    key: 'power',
    name: 'Power',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.POWER,
    unit: UNITS.WATT,
    min: 0,
    max: 30_000,
    decode: parseHex,
  },
  KWATT: {
    key: 'energy',
    name: 'Energy',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.ENERGY,
    unit: UNITS.KILOWATT_HOUR,
    min: 0,
    max: 1_000_000,
    decode: parseHex,
  },
  VOLT: {
    key: 'voltage',
    name: 'Voltage',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.VOLTAGE,
    unit: UNITS.VOLT,
    min: 0,
    max: 500,
    decode: parseDecimal,
  },
  CURRENT: {
    key: 'current',
    name: 'Current (phase 1)',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.CURRENT,
    unit: UNITS.AMPERE,
    min: 0,
    max: 100,
    decode: parseDecimal,
  },
  CURRENT2: {
    key: 'current2',
    name: 'Current (phase 2)',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.CURRENT,
    unit: UNITS.AMPERE,
    min: 0,
    max: 100,
    decode: parseDecimal,
  },
  CURRENT3: {
    key: 'current3',
    name: 'Current (phase 3)',
    category: CATEGORIES.ENERGY_SENSOR,
    type: TYPES.ENERGY_SENSOR.CURRENT,
    unit: UNITS.AMPERE,
    min: 0,
    max: 100,
    decode: parseDecimal,
  },
  METER: {
    key: 'meter',
    name: 'Meter',
    category: CATEGORIES.COUNTER_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    min: 0,
    max: 1_000_000_000,
    decode: parseDecimal,
  },

  // --- Misc ------------------------------------------------------------------
  DIST: {
    key: 'distance',
    name: 'Distance',
    category: CATEGORIES.DISTANCE_SENSOR,
    // Same reason as HUM: `distance-sensor` is only registered with `decimal`.
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CM,
    min: 0,
    max: 10_000,
    decode: parseDecimal,
  },
  BAT: {
    key: 'battery-low',
    name: 'Battery low',
    category: CATEGORIES.BATTERY_LOW,
    type: TYPES.BATTERY_LOW.BINARY,
    min: 0,
    max: 1,
    // RFLink reports the battery as OK / LOW, and Gladys' BATTERY_LOW feature
    // is true when the battery is FLAT: the mapping is inverted on purpose.
    decode: (raw) => {
      const value = String(raw).toUpperCase();
      if (value === 'OK') {
        return 0;
      }
      if (value === 'LOW') {
        return 1;
      }
      return null;
    },
  },
};

// A device that dims is a light, not a plain switch: its on/off feature is
// rendered next to the brightness slider only if both share the LIGHT
// category. Same feature `key`, so switching a device to this variant never
// breaks the history of an existing feature.
const DIMMABLE_ON_OFF = {
  ...RFLINK_FIELDS.CMD,
  category: CATEGORIES.LIGHT,
  type: TYPES.LIGHT.BINARY,
};

/**
 * The Gladys feature descriptor of one RFLink label, in the context of the
 * device's whole label set.
 * @param {string} label - RFLink field label, e.g. 'TEMP'.
 * @param {string[]} deviceLabels - Every label this device has reported.
 * @returns {object|undefined} The descriptor, undefined for an unsupported label.
 */
export function fieldDescriptor(label, deviceLabels = []) {
  if (label === 'CMD' && deviceLabels.includes('SET_LEVEL')) {
    return DIMMABLE_ON_OFF;
  }
  return RFLINK_FIELDS[label];
}

/**
 * The RFLink label behind a controllable Gladys feature key — the inverse
 * lookup the command path needs, so the feature keys live in ONE place.
 * @param {string} featureKey - Feature key, e.g. 'cmd' or 'brightness'.
 * @returns {string|null} The RFLink label, or null for a read-only feature.
 */
export function controllableLabel(featureKey) {
  const found = Object.entries(RFLINK_FIELDS).find(
    ([, descriptor]) => descriptor.read_only === false && descriptor.key === featureKey,
  );
  return found?.[0] ?? null;
}

/**
 * Normalize the measurements of a device frame before mapping them.
 *
 * RFLink nests the dim level inside the command field
 * (`CMD=SET_LEVEL=13`), which our generic `KEY=VALUE` split leaves as the
 * string `'SET_LEVEL=13'` under `CMD`. Unfolding it here keeps the field
 * table flat and every consumer unaware of the quirk.
 * @param {Record<string, string>} values - Raw measurements of the frame.
 * @returns {Record<string, string>} Normalized measurements.
 */
export function normalizeMeasurements(values = {}) {
  const normalized = { ...values };
  const command = normalized.CMD;
  if (typeof command === 'string' && command.toUpperCase().startsWith('SET_LEVEL=')) {
    normalized.SET_LEVEL = command.slice(command.indexOf('=') + 1).trim();
    delete normalized.CMD;
  }
  return normalized;
}

/**
 * Keep only the labels this integration knows how to expose.
 * @param {Record<string, string>} values - Normalized measurements.
 * @returns {string[]} Supported labels, in a stable order.
 */
export function supportedLabels(values = {}) {
  return Object.keys(values).filter((label) => RFLINK_FIELDS[label] !== undefined);
}

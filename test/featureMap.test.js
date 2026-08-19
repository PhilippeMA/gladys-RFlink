import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

import {
  controllableLabel,
  fieldDescriptor,
  IGNORED_FIELDS,
  levelToPercent,
  normalizeMeasurements,
  percentToLevel,
  RFLINK_FIELDS,
  supportedLabels,
} from '../src/devices/featureMap.js';

test('every field entry is complete enough to build a Gladys feature', () => {
  for (const [label, descriptor] of Object.entries(RFLINK_FIELDS)) {
    assert.ok(descriptor.key, `${label} needs a feature key`);
    assert.ok(descriptor.name, `${label} needs a name`);
    assert.ok(descriptor.category, `${label} needs a category`);
    assert.ok(descriptor.type, `${label} needs a type`);
    assert.equal(typeof descriptor.decode, 'function', `${label} needs a decoder`);
  }
});

test('feature keys are unique, so two fields never share a history', () => {
  const keys = Object.values(RFLINK_FIELDS).map((descriptor) => descriptor.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('decodes the common sensor fields with the right radix and scale', () => {
  assert.equal(RFLINK_FIELDS.TEMP.decode('00b4'), 18);
  assert.equal(RFLINK_FIELDS.HUM.decode('44'), 44);
  assert.equal(RFLINK_FIELDS.BARO.decode('03f2'), 1010);
  assert.equal(RFLINK_FIELDS.RAIN.decode('0044'), 6.8);
  assert.equal(RFLINK_FIELDS.WINSP.decode('0032'), 5);
  assert.equal(RFLINK_FIELDS.WATT.decode('0064'), 100);
});

test('an unreadable field decodes to null instead of NaN', () => {
  assert.equal(RFLINK_FIELDS.HUM.decode('??'), null);
  assert.equal(RFLINK_FIELDS.TEMP.decode(''), null);
  assert.equal(RFLINK_FIELDS.CMD.decode('SET_LEVEL=13'), null);
});

test('ON/OFF and ALLON/ALLOFF both drive the switch feature', () => {
  assert.equal(RFLINK_FIELDS.CMD.decode('ON'), 1);
  assert.equal(RFLINK_FIELDS.CMD.decode('off'), 0);
  assert.equal(RFLINK_FIELDS.CMD.decode('ALLON'), 1);
  assert.equal(RFLINK_FIELDS.CMD.decode('ALLOFF'), 0);
});

test('the battery mapping is inverted: Gladys BATTERY_LOW is true when flat', () => {
  assert.equal(RFLINK_FIELDS.BAT.decode('OK'), 0);
  assert.equal(RFLINK_FIELDS.BAT.decode('LOW'), 1);
});

test('wind direction becomes degrees, not one of the 16 raw sectors', () => {
  // The reference documents sectors 0-15 but writes them hexadecimally, like
  // every other measurement: `WINDIR=0005` in its own samples.
  assert.equal(RFLINK_FIELDS.WINDIR.decode('0'), 0);
  assert.equal(RFLINK_FIELDS.WINDIR.decode('0004'), 90);
  assert.equal(RFLINK_FIELDS.WINDIR.decode('8'), 180);
  assert.equal(RFLINK_FIELDS.WINDIR.decode('000f'), 338);
  // Out of the documented range (the UPM/Esic sample sends `WINDIR=5A`):
  // refused rather than turned into an invented bearing.
  assert.equal(RFLINK_FIELDS.WINDIR.decode('5A'), null);
});

test('dim levels and percentages convert both ways', () => {
  assert.equal(levelToPercent(0), 0);
  assert.equal(levelToPercent(15), 100);
  assert.equal(percentToLevel(0), 0);
  assert.equal(percentToLevel(100), 15);
  assert.equal(percentToLevel(50), 8);
  // Out-of-range input is clamped rather than transmitted as-is.
  assert.equal(percentToLevel(300), 15);
  assert.equal(levelToPercent(99), 100);
});

test('a dimmable device gets a LIGHT on/off, a plain one gets a SWITCH', () => {
  const dimmable = fieldDescriptor('CMD', ['CMD', 'SET_LEVEL']);
  assert.equal(dimmable.category, CATEGORIES.LIGHT);
  assert.equal(dimmable.type, TYPES.LIGHT.BINARY);

  const plain = fieldDescriptor('CMD', ['CMD']);
  assert.equal(plain.category, CATEGORIES.SWITCH);
  assert.equal(plain.type, TYPES.SWITCH.BINARY);

  // Same feature key in both variants: turning a switch into a light must not
  // orphan the history of the feature the user already created.
  assert.equal(dimmable.key, plain.key);
});

test('unfolds the dim level RFLink nests inside CMD', () => {
  assert.deepEqual(normalizeMeasurements({ CMD: 'SET_LEVEL=13' }), { SET_LEVEL: '13' });
  assert.deepEqual(normalizeMeasurements({ CMD: 'ON' }), { CMD: 'ON' });
  assert.deepEqual(normalizeMeasurements(), {});
});

test('only the labels the integration knows about become features', () => {
  assert.deepEqual(supportedLabels({ TEMP: '00b4', HUM: '44', RFDEBUG: 'ON' }), ['TEMP', 'HUM']);
  assert.deepEqual(supportedLabels({}), []);
});

test('the derived fields get no feature at all', () => {
  // HSTATUS is bucketed from HUM and BFORECAST from BARO. Mapped to the
  // `unknown` category they rendered as a nameless, iconless line sitting next
  // to the humidity they are computed from — a blank feature nobody can read.
  for (const label of IGNORED_FIELDS) {
    assert.equal(RFLINK_FIELDS[label], undefined, `${label} must not be mapped`);
    assert.equal(fieldDescriptor(label, [label]), undefined);
  }
  assert.deepEqual(supportedLabels({ HUM: '37', HSTATUS: '2', BFORECAST: '3' }), ['HUM']);
});

// Every (category, type) pair this integration can publish.
//
// Gladys resolves BOTH a feature's icon and its translated label by the exact
// pair — `DeviceFeatureCategoriesIcon[category][type]` in the front, falling
// back to a generic slider, and `deviceFeatureCategory.<category>.<type>` in
// the translations, falling back to the raw feature name. A pair Gladys does
// not register therefore renders as a nameless, iconless line even though the
// value arrives perfectly: that is exactly how `humidity-sensor|integer`
// shipped, when `humidity-sensor` is only registered with `decimal`.
//
// Nothing in this repository can check the pairs against a running Gladys, so
// they are pinned here instead: adding a field must be a deliberate edit to
// this list, verified against `front/src/utils/consts.js` and
// `front/src/config/i18n/en.json` in GladysAssistant/Gladys.
const CATEGORY_TYPE_CONTRACT = [
  'angle-sensor|integer',
  'battery-low|binary',
  'co2-sensor|integer',
  'counter-sensor|integer',
  'distance-sensor|decimal',
  'doorbell|ring',
  'energy-sensor|current',
  'energy-sensor|energy',
  'energy-sensor|power',
  'energy-sensor|voltage',
  'humidity-sensor|decimal',
  'light-sensor|integer',
  'light|brightness',
  'motion-sensor|binary',
  'noise-sensor|integer',
  'precipitation-sensor|decimal',
  'pressure-sensor|integer',
  'smoke-sensor|binary',
  'speed-sensor|decimal',
  'switch|binary',
  'temperature-sensor|decimal',
  'uv-sensor|integer',
];

test('the category/type pairs stay the ones Gladys knows how to render', () => {
  const used = [
    ...new Set(Object.values(RFLINK_FIELDS).map((d) => `${d.category}|${d.type}`)),
  ].sort();
  assert.deepEqual(used, CATEGORY_TYPE_CONTRACT);
});

test('a percentage sensor is decimal, whatever the wire sends', () => {
  // RFLink only sends whole percents, but `humidity-sensor` exists in Gladys
  // as `decimal` alone: typing it `integer` costs the droplet icon and the
  // label, for no gain.
  assert.equal(RFLINK_FIELDS.HUM.type, TYPES.SENSOR.DECIMAL);
  assert.equal(RFLINK_FIELDS.HUM.decode('37'), 37);
});

test('no feature is left in the unknown category', () => {
  // A feature Gladys cannot name is a feature the user sees blank.
  for (const [label, descriptor] of Object.entries(RFLINK_FIELDS)) {
    assert.notEqual(descriptor.category, CATEGORIES.UNKNOWN, `${label} has no real category`);
  }
});

test('a Gladys command maps back to exactly one RFLink label', () => {
  assert.equal(controllableLabel(RFLINK_FIELDS.CMD.key), 'CMD');
  assert.equal(controllableLabel(RFLINK_FIELDS.SET_LEVEL.key), 'SET_LEVEL');
  // A sensor feature is not commandable, whatever Gladys sends.
  assert.equal(controllableLabel(RFLINK_FIELDS.TEMP.key), null);
  assert.equal(controllableLabel('nope'), null);
});

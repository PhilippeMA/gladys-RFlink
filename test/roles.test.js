import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
} from '@gladysassistant/integration-sdk';

import {
  applyRole,
  DEFAULT_ROLE,
  DEVICE_ROLES,
  encodeRoleCommand,
  isKnownRole,
  pulseSecondsFor,
  roleFromFrame,
  roleKeys,
} from '../src/devices/roles.js';
import { RFLINK_FIELDS } from '../src/devices/featureMap.js';

test('every role is complete enough to build a Gladys feature', () => {
  for (const [key, spec] of Object.entries(DEVICE_ROLES)) {
    assert.ok(spec.name, `${key} needs a name`);
    assert.ok(spec.category, `${key} needs a category`);
    assert.ok(spec.type, `${key} needs a type`);
    assert.equal(typeof spec.controllable, 'boolean', `${key} needs a controllable flag`);
    assert.ok(
      spec.pulseSeconds === null || spec.pulseSeconds > 0,
      `${key}: pulseSeconds is a delay or null`,
    );
  }
});

test('the default role is the catalog entry RFLink reports literally', () => {
  assert.ok(isKnownRole(DEFAULT_ROLE));
  assert.equal(DEVICE_ROLES[DEFAULT_ROLE].category, CATEGORIES.SWITCH);
  assert.equal(DEVICE_ROLES[DEFAULT_ROLE].controllable, true);
});

test('an EV1527 PIR becomes a read-only motion sensor', () => {
  const asSwitch = RFLINK_FIELDS.CMD;
  const asMotion = applyRole(asSwitch, 'CMD', 'motion');

  assert.equal(asMotion.category, CATEGORIES.MOTION_SENSOR);
  assert.equal(asMotion.type, TYPES.SENSOR.BINARY);
  assert.equal(asMotion.read_only, true, 'you cannot command a PIR');
  // Same feature key: re-typing a device must not orphan its history.
  assert.equal(asMotion.key, asSwitch.key);
});

test('a role never touches the other measurements of the device', () => {
  const temperature = applyRole(RFLINK_FIELDS.TEMP, 'TEMP', 'motion');
  assert.deepEqual(temperature, RFLINK_FIELDS.TEMP);
});

test('the default role and an unknown role both leave the descriptor alone', () => {
  assert.deepEqual(applyRole(RFLINK_FIELDS.CMD, 'CMD', DEFAULT_ROLE), RFLINK_FIELDS.CMD);
  assert.deepEqual(applyRole(RFLINK_FIELDS.CMD, 'CMD', 'teleporter'), RFLINK_FIELDS.CMD);
  assert.deepEqual(applyRole(RFLINK_FIELDS.CMD, 'CMD', undefined), RFLINK_FIELDS.CMD);
});

test('a controllable role keeps the feature writable', () => {
  assert.equal(applyRole(RFLINK_FIELDS.CMD, 'CMD', 'siren').read_only, false);
  assert.equal(applyRole(RFLINK_FIELDS.CMD, 'CMD', 'light').read_only, false);
});

test('only the roles that report a detection without an end are pulsed', () => {
  assert.equal(pulseSecondsFor({ role: 'motion' }), 60);
  assert.equal(pulseSecondsFor({ role: 'doorbell' }), 2);
  // A reed contact transmits on open AND on close: resetting it would erase a
  // door that is genuinely still open.
  assert.equal(pulseSecondsFor({ role: 'opening' }), null);
  assert.equal(pulseSecondsFor({ role: 'switch' }), null);
  assert.equal(pulseSecondsFor({ role: 'nope' }), null);
  assert.equal(pulseSecondsFor(undefined), null);
});

test('the per-device delay wins, and 0 disables the reset', () => {
  assert.equal(pulseSecondsFor({ role: 'motion', resetAfter: 15 }), 15);
  assert.equal(pulseSecondsFor({ role: 'motion', resetAfter: 0 }), null);
  assert.equal(pulseSecondsFor({ role: 'motion', resetAfter: null }), 60);
  assert.equal(pulseSecondsFor({ role: 'motion', resetAfter: -5 }), 60);
});

test('the roles stay on category/type pairs Gladys knows how to render', () => {
  // Same contract as CATEGORY_TYPE_CONTRACT in featureMap.test.js: a pair
  // Gladys does not register loses its icon and its label, however correct the
  // value is. Adding a role means checking the new pair against
  // `front/src/utils/consts.js` in GladysAssistant/Gladys.
  const used = [
    ...new Set(Object.values(DEVICE_ROLES).map((s) => `${s.category}|${s.type}`)),
  ].sort();
  assert.deepEqual(used, [
    'button|click',
    'curtain|state',
    'doorbell|ring',
    'input|binary',
    'leak-sensor|binary',
    'light|binary',
    'motion-sensor|binary',
    'opening-sensor|binary',
    'presence-sensor|binary',
    'shutter|state',
    'siren|binary',
    'smoke-sensor|binary',
    'switch|binary',
    'vibration-sensor|binary',
  ]);
});

// --- Covers: Somfy RTS and friends -------------------------------------------

test('a frame carrying UP, DOWN or STOP names its own class', () => {
  // Unlike an EV1527 chip, this is not a guess: no switch, remote or sensor
  // emits those words. `20;1E;RTS;ID=f1e260;SWITCH=01;CMD=DOWN;` is a cover.
  assert.equal(roleFromFrame({ CMD: 'DOWN' }), 'shutter');
  assert.equal(roleFromFrame({ CMD: 'UP' }), 'shutter');
  assert.equal(roleFromFrame({ CMD: 'STOP' }), 'shutter');
  assert.equal(roleFromFrame({ CMD: 'ON' }), null);
  assert.equal(roleFromFrame({ TEMP: '00b4' }), null);
  assert.equal(roleFromFrame(), null);
});

test('a shutter reads UP/DOWN/STOP as the three Gladys cover values', () => {
  // COVER_STATE in the Gladys core: OPEN 1, STOP 0, CLOSE -1.
  const shutter = applyRole(RFLINK_FIELDS.CMD, 'CMD', 'shutter');
  assert.equal(shutter.category, CATEGORIES.SHUTTER);
  assert.equal(shutter.type, TYPES.SHUTTER.STATE);
  assert.equal(shutter.read_only, false);
  assert.equal(shutter.min, -1);
  assert.equal(shutter.max, 1);

  assert.equal(shutter.decode('UP'), 1);
  assert.equal(shutter.decode('DOWN'), -1);
  assert.equal(shutter.decode('STOP'), 0);
  assert.equal(shutter.decode('ON'), null, 'a cover has no ON');
});

test('a shutter writes the three cover values back as RFLink words', () => {
  assert.equal(encodeRoleCommand('shutter', 1), 'UP');
  assert.equal(encodeRoleCommand('shutter', -1), 'DOWN');
  assert.equal(encodeRoleCommand('shutter', 0), 'STOP');
  assert.equal(encodeRoleCommand('curtain', 1), 'UP');
  // Out of the cover vocabulary: null, never a silent fallback to ON.
  assert.equal(encodeRoleCommand('shutter', 42), null);
  // A role without its own vocabulary says so, so ON/OFF stays the default.
  assert.equal(encodeRoleCommand('switch', 1), undefined);
  assert.equal(encodeRoleCommand('motion', 1), undefined);
});

test('a cover is never pulsed: a closed shutter stays closed', () => {
  assert.equal(pulseSecondsFor({ role: 'shutter' }), null);
  assert.equal(pulseSecondsFor({ role: 'curtain' }), null);
});

test('roleKeys lists exactly the catalog', () => {
  assert.deepEqual(roleKeys(), Object.keys(DEVICE_ROLES));
  assert.ok(roleKeys().includes('motion'));
});

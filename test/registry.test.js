import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES as CATEGORIES } from '@gladysassistant/integration-sdk';

import { createFakeGladys, createFakeStore } from './helpers/fakeGladys.js';
import { parseFrame } from '../src/rflink/protocol.js';
import {
  DeviceRegistry,
  defaultName,
  entryKey,
  externalIdsFor,
  PARAMS,
  slug,
} from '../src/devices/registry.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function createRegistry({ gladys = createFakeGladys(), store = createFakeStore(), ...rest } = {}) {
  return {
    gladys,
    store,
    registry: new DeviceRegistry({ gladys, store, logger: silent, ...rest }),
  };
}

const learn = (registry, line, options) => registry.learn(parseFrame(line), options);

test('slugs make protocol names safe for an external id', () => {
  assert.equal(slug('Oregon TempHygro'), 'oregon-temphygro');
  assert.equal(slug('Alecto V4'), 'alecto-v4');
  assert.equal(slug('  ???  '), 'unknown');
});

test('the unit is part of the identity: two buttons are two devices', () => {
  const a = entryKey({ protocol: 'NewKaku', id: '000005', unit: '1' });
  const b = entryKey({ protocol: 'NewKaku', id: '000005', unit: '2' });
  assert.notEqual(a, b);
  // A sensor has no unit at all, which is again a distinct identity.
  assert.notEqual(a, entryKey({ protocol: 'NewKaku', id: '000005', unit: null }));
});

test('external ids embed the protocol and the address, and stay stable', () => {
  const gladys = createFakeGladys();
  const ids = externalIdsFor(gladys, { protocol: 'Oregon TempHygro', id: '0710', unit: null });
  assert.equal(ids.device, 'ext:rflink:oregon-temphygro:0710');
  assert.equal(ids.feature('temperature'), 'ext:rflink:oregon-temphygro:0710:temperature');

  const withUnit = externalIdsFor(gladys, { protocol: 'NewKaku', id: '000005', unit: '2' });
  assert.equal(withUnit.device, 'ext:rflink:newkaku:000005-2');
});

test('names a device after what the gateway reported', () => {
  assert.equal(
    defaultName({ protocol: 'NewKaku', id: '000005', unit: '2' }),
    'NewKaku 000005 (unit 2)',
  );
  assert.equal(
    defaultName({ protocol: 'Oregon TempHygro', id: '0710', unit: null }),
    'Oregon TempHygro 0710',
  );
});

test('learns a device the first time it is heard, then recognizes it', () => {
  const { registry, store } = createRegistry();

  const first = learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  assert.equal(first.isNew, true);
  assert.deepEqual(first.entry.labels, ['CMD']);
  assert.ok(store.writes > 0, 'a newly learned device is persisted');

  const second = learn(registry, '20;2E;NewKaku;ID=000005;SWITCH=2;CMD=OFF;');
  assert.equal(second.isNew, false);
  assert.equal(second.changed, false);
  assert.equal(registry.list().length, 1);
});

test('a device that starts reporting a new measurement is a structure change', () => {
  const { registry } = createRegistry();

  learn(registry, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');
  const grown = learn(registry, '20;A0;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;');

  assert.equal(grown.isNew, false);
  assert.equal(grown.changed, true, 'Gladys must be told the feature list grew');
  assert.deepEqual(grown.entry.labels, ['TEMP', 'HUM']);
});

test('without auto-discovery, unknown devices are dropped and known ones still work', () => {
  const { registry } = createRegistry();

  const ignored = learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;', {
    autoDiscover: false,
  });
  assert.equal(ignored.entry, null);
  assert.equal(registry.list().length, 0);

  learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  const known = learn(registry, '20;2E;NewKaku;ID=000005;SWITCH=2;CMD=OFF;', {
    autoDiscover: false,
  });
  assert.ok(known.entry, 'an already-known device keeps publishing its states');
});

test('a frame with no supported measurement never creates a device', () => {
  const { registry } = createRegistry();
  const result = learn(registry, '20;33;Mystery;ID=00ff;WEIRDFIELD=42;');
  assert.equal(result.entry, null);
  assert.equal(registry.list().length, 0);
});

test('the registry stops growing at its ceiling', () => {
  const { registry } = createRegistry({ maxDevices: 2 });

  learn(registry, '20;01;Kaku;ID=000001;SWITCH=1;CMD=ON;');
  learn(registry, '20;02;Kaku;ID=000002;SWITCH=1;CMD=ON;');
  const overflow = learn(registry, '20;03;Kaku;ID=000003;SWITCH=1;CMD=ON;');

  assert.equal(overflow.entry, null);
  assert.equal(registry.list().length, 2);
});

test('builds a discovery payload carrying the RF address as params', () => {
  const { registry } = createRegistry();
  learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');

  const [device] = registry.buildDiscoveredDevices();
  assert.equal(device.external_id, 'ext:rflink:newkaku:000005-2');
  assert.deepEqual(device.params, [
    { name: PARAMS.PROTOCOL, value: 'NewKaku' },
    { name: PARAMS.ID, value: '000005' },
    { name: PARAMS.UNIT, value: '2' },
  ]);

  const [feature] = device.features;
  assert.equal(feature.category, CATEGORIES.SWITCH);
  assert.equal(feature.read_only, false);
  // 433 MHz is one-way: claiming feedback would leave Gladys waiting forever.
  assert.equal(feature.has_feedback, false);
});

test('a sensor gets read-only features and no unit param', () => {
  const { registry } = createRegistry();
  learn(registry, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;BAT=OK;');

  const [device] = registry.buildDiscoveredDevices();
  assert.equal(device.params.length, 2, 'a sensor has no SWITCH, so no unit param');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    ['temperature', 'humidity', 'battery-low'],
  );
  assert.ok(device.features.every((feature) => feature.read_only === true));
});

test('turns the measurements of a frame into a Gladys state batch', () => {
  const { registry } = createRegistry();
  const { entry, values } = learn(
    registry,
    '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;BAT=LOW;',
  );

  assert.deepEqual(registry.buildStates(entry, values), [
    { device_feature_external_id: 'ext:rflink:oregon-temphygro:0710:temperature', state: 18 },
    { device_feature_external_id: 'ext:rflink:oregon-temphygro:0710:humidity', state: 44 },
    { device_feature_external_id: 'ext:rflink:oregon-temphygro:0710:battery-low', state: 1 },
  ]);
});

test('an undecodable measurement is skipped, the others still publish', () => {
  const { registry } = createRegistry();
  const { entry } = learn(registry, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;');

  const states = registry.buildStates(entry, { TEMP: '00b4', HUM: 'oops' });
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 18);
});

test('reloads the learned devices from the store', async () => {
  const store = createFakeStore();
  const { registry } = createRegistry({ store });
  learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');

  const { registry: reloaded } = createRegistry({ store });
  await reloaded.load();

  assert.equal(reloaded.list().length, 1);
  assert.deepEqual(reloaded.list()[0].labels, ['CMD']);
});

test('a corrupt store entry is skipped rather than crashing the startup', async () => {
  const store = createFakeStore({
    version: 1,
    devices: [
      { protocol: 'NewKaku', id: '000005', unit: '2', labels: ['CMD'] },
      { id: 'no-proto' },
      null,
    ],
  });
  const { registry } = createRegistry({ store });
  await registry.load();
  assert.equal(registry.list().length, 1);
});

test('resolve finds the RF address of a Gladys device', () => {
  const { registry } = createRegistry();
  learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');

  const target = registry.resolve('ext:rflink:newkaku:000005-2');
  assert.equal(target.protocol, 'NewKaku');
  assert.equal(target.id, '000005');
  assert.equal(target.unit, '2');
  assert.equal(registry.resolve('ext:rflink:newkaku:999999-1'), null);
});

test('resolve falls back to the device params when the /data cache was lost', () => {
  // The container was recreated with an empty volume: the device still exists
  // in Gladys, and its params carry everything needed to command it.
  const gladys = createFakeGladys([
    {
      external_id: 'ext:rflink:newkaku:000005-2',
      params: [
        { name: PARAMS.PROTOCOL, value: 'NewKaku' },
        { name: PARAMS.ID, value: '000005' },
        { name: PARAMS.UNIT, value: '2' },
      ],
    },
  ]);
  const { registry } = createRegistry({ gladys });

  const target = registry.resolve('ext:rflink:newkaku:000005-2', gladys.devices);
  assert.equal(target.protocol, 'NewKaku');
  assert.equal(target.unit, '2');

  // A device without our params is not ours to command.
  assert.equal(registry.resolve('ext:other:thing', [{ external_id: 'ext:other:thing' }]), null);
});

test('forgetting the undiscovered devices keeps the created ones', () => {
  const { registry } = createRegistry();
  learn(registry, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  learn(registry, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');

  const dropped = registry.forgetUncreated(['ext:rflink:newkaku:000005-2']);

  assert.equal(dropped, 1);
  assert.deepEqual(
    registry.list().map((entry) => entry.protocol),
    ['NewKaku'],
  );
});

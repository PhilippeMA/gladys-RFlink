// -----------------------------------------------------------------------------
// End-to-end of the two traffic directions, with a fake Gladys, a fake gateway
// and a real registry: a raw RFLink line goes in, published states come out —
// and a Gladys command comes out as an RFLink command line.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGladys, createFakeStore } from './helpers/fakeGladys.js';
import { commandFor, createPipeline } from '../src/pipeline.js';
import { DeviceRegistry, PARAMS } from '../src/devices/registry.js';
import { normalizeConfig } from '../src/config.js';
import { parseFrame } from '../src/rflink/protocol.js';
import { RFLINK_FIELDS } from '../src/devices/featureMap.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

const SWITCH_ID = 'ext:rflink:newkaku:000005-2';
const SENSOR_ID = 'ext:rflink:oregon-temphygro:0710';

/**
 * @param {object} [options] - Options.
 * @param {object} [options.config] - Raw configuration to normalize.
 * @param {object[]} [options.createdDevices] - Devices the user created in Gladys.
 * @returns {object} `{ pipeline, gladys, registry, sent, changes }`.
 */
function setup({ config = {}, createdDevices = [], duplicateWindowMs } = {}) {
  const gladys = createFakeGladys(createdDevices);
  const registry = new DeviceRegistry({
    gladys,
    store: createFakeStore(),
    logger: silent,
  });
  const sent = [];
  const changes = { count: 0 };

  const pipeline = createPipeline({
    gladys,
    registry,
    getConfig: () => normalizeConfig(config),
    getGateway: () => ({ send: async (line) => sent.push(line) }),
    onDevicesChanged: () => {
      changes.count += 1;
    },
    logger: silent,
    ...(duplicateWindowMs === undefined ? {} : { duplicateWindowMs }),
  });

  return { pipeline, gladys, registry, sent, changes };
}

// `setRole` and the pulse tests need the registry, so the helper exposes it.

const feed = (pipeline, line) => pipeline.handleFrame(parseFrame(line));

test('a sensor frame learns the device and asks for a discovery publish', async () => {
  const { pipeline, registry, changes } = setup();

  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;');

  assert.equal(registry.list().length, 1);
  assert.equal(changes.count, 1);
});

test('states are published only for the devices the user created', async () => {
  const notCreated = setup();
  await feed(notCreated.pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');
  assert.deepEqual(notCreated.gladys.published, [], 'publishing here would 404 on every frame');

  const created = setup({ createdDevices: [{ external_id: SENSOR_ID }] });
  await feed(created.pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;');

  assert.deepEqual(created.gladys.published, [
    { featureExternalId: `${SENSOR_ID}:temperature`, state: 18 },
    { featureExternalId: `${SENSOR_ID}:humidity`, state: 44 },
  ]);
});

test('the radio repeats of one transmission are published once', async () => {
  const { pipeline, gladys } = setup({ createdDevices: [{ external_id: SENSOR_ID }] });
  const line = '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;';

  // Most 433 MHz protocols send the same packet 2 to 4 times in a row.
  await feed(pipeline, line);
  await feed(pipeline, line);
  await feed(pipeline, line);

  assert.equal(gladys.published.length, 1);
});

test('a repeat carrying a DIFFERENT value is a real update', async () => {
  const { pipeline, gladys } = setup({ createdDevices: [{ external_id: SENSOR_ID }] });

  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');
  await feed(pipeline, '20;A0;Oregon TempHygro;ID=0710;TEMP=00b5;');

  assert.deepEqual(
    gladys.published.map((entry) => entry.state),
    [18, 18.1],
  );
});

test('an ignored protocol never reaches the registry', async () => {
  const { pipeline, registry, gladys } = setup({
    config: { ignored_protocols: 'oregon temphygro' },
    createdDevices: [{ external_id: SENSOR_ID }],
  });

  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');

  assert.equal(registry.list().length, 0);
  assert.deepEqual(gladys.published, []);
});

test('with auto-discovery off, an unknown device is silently dropped', async () => {
  const { pipeline, registry, changes } = setup({ config: { auto_discover: false } });

  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');

  assert.equal(registry.list().length, 0);
  assert.equal(changes.count, 0);
});

test('gateway answers and status lines produce nothing at all', async () => {
  const { pipeline, registry, gladys, changes } = setup();

  await feed(pipeline, '20;06;OK;');
  await feed(pipeline, '20;07;PONG;');
  await feed(pipeline, '20;08;VER=1.1;REV=48;BUILD=07;');
  await feed(pipeline, '20;00;Nodo RadioFrequencyLink - RFLink Gateway V1.1 - R48;');
  await feed(pipeline, '20;11;STATUS;setRF433=ON;');

  assert.equal(registry.list().length, 0);
  assert.deepEqual(gladys.published, []);
  assert.equal(changes.count, 0);
});

test('a device that grows a feature asks for a new discovery publish', async () => {
  const { pipeline, changes } = setup();

  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');
  await feed(pipeline, '20;A0;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;');

  assert.equal(changes.count, 2, 'discovery is stale on creation AND on a structure change');
});

test('a Gladys on/off becomes an RFLink command line', async () => {
  const { pipeline, sent } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });
  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');

  const device = { external_id: SWITCH_ID };
  await pipeline.handleSetValue(device, { external_id: `${SWITCH_ID}:cmd` }, 1);
  await pipeline.handleSetValue(device, { external_id: `${SWITCH_ID}:cmd` }, 0);

  assert.deepEqual(sent, ['10;NewKaku;000005;2;ON;', '10;NewKaku;000005;2;OFF;']);
});

test('a brightness percentage becomes an RFLink dim level', async () => {
  const { pipeline, sent } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });
  await feed(pipeline, '20;05;NewKaku;ID=000005;SWITCH=2;CMD=SET_LEVEL=13;');

  await pipeline.handleSetValue(
    { external_id: SWITCH_ID },
    { external_id: `${SWITCH_ID}:brightness` },
    100,
  );

  assert.deepEqual(sent, ['10;NewKaku;000005;2;15;']);
});

test('nothing is published back after a command: 433 MHz gives no feedback', async () => {
  const { pipeline, gladys } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });
  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  gladys.published.length = 0;

  await pipeline.handleSetValue({ external_id: SWITCH_ID }, { external_id: `${SWITCH_ID}:cmd` }, 1);

  assert.deepEqual(gladys.published, [], 'Gladys records the requested value itself');
});

test('a command on an unknown device fails the ack instead of transmitting', async () => {
  const { pipeline, sent } = setup();

  await assert.rejects(
    pipeline.handleSetValue(
      { external_id: 'ext:rflink:newkaku:999999-1' },
      { external_id: 'ext:rflink:newkaku:999999-1:cmd' },
      1,
    ),
    /Unknown RFLink device/,
  );
  assert.deepEqual(sent, []);
});

test('a command on a read-only feature fails the ack', async () => {
  const { pipeline, sent } = setup({ createdDevices: [{ external_id: SENSOR_ID }] });
  await feed(pipeline, '20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;');

  await assert.rejects(
    pipeline.handleSetValue(
      { external_id: SENSOR_ID },
      { external_id: `${SENSOR_ID}:temperature` },
      21,
    ),
    /cannot be controlled/,
  );
  assert.deepEqual(sent, []);
});

test('a command still works when only the Gladys params survived', async () => {
  // The /data volume was wiped: the registry is empty, but the device created
  // in Gladys carries its RF address.
  const { pipeline, sent } = setup({
    createdDevices: [
      {
        external_id: SWITCH_ID,
        params: [
          { name: PARAMS.PROTOCOL, value: 'NewKaku' },
          { name: PARAMS.ID, value: '000005' },
          { name: PARAMS.UNIT, value: '2' },
        ],
      },
    ],
  });

  await pipeline.handleSetValue({ external_id: SWITCH_ID }, { external_id: `${SWITCH_ID}:cmd` }, 1);

  assert.deepEqual(sent, ['10;NewKaku;000005;2;ON;']);
});

// --- Replaying the last reading onto a freshly added device ------------------

test('adding a device replays what we already heard, timestamped when measured', async () => {
  // The reported case: an Alecto V4 heard before the user adds it. Without the
  // replay its features stay blank until the sensor next transmits.
  const gladys = createFakeGladys();
  const registry = new DeviceRegistry({ gladys, store: createFakeStore(), logger: silent });
  const pipeline = createPipeline({
    gladys,
    registry,
    getConfig: () => normalizeConfig(),
    getGateway: () => null,
    onDevicesChanged: () => {},
    logger: silent,
  });
  const externalId = 'ext:rflink:alecto-v4:5b99';

  await feed(pipeline, '20;26;Alecto V4;ID=5b99;TEMP=0128;HUM=37;');
  assert.deepEqual(gladys.published, [], 'not created yet, nothing to publish to');

  // The user adds it from the Discovery screen.
  gladys.devices = [{ external_id: externalId }];
  await pipeline.handleDeviceKnown({ external_id: externalId });

  assert.deepEqual(
    gladys.published.map(({ featureExternalId, state }) => ({ featureExternalId, state })),
    [
      { featureExternalId: `${externalId}:temperature`, state: 29.6 },
      { featureExternalId: `${externalId}:humidity`, state: 37 },
    ],
  );
});

test('the replay carries no state for a device we never heard', async () => {
  const { pipeline, gladys } = setup();
  await pipeline.handleDeviceKnown({ external_id: 'ext:rflink:newkaku:000005-2' });
  assert.deepEqual(gladys.published, []);
});

// --- Pulsed sensors ----------------------------------------------------------

// A PIR is learned from its first transmission, and the role can only be set
// once the device exists. The first frame therefore carries OFF: two identical
// ON frames in a row would be swallowed by the radio-repeat deduplication and
// the test would pass without ever exercising the reset.
const learnThenType = async (pipeline, registry, resetAfter) => {
  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=OFF;');
  registry.setRole(SWITCH_ID, 'motion', resetAfter);
};

test('a motion sensor returns to 0 on its own, since it never sends OFF', async () => {
  const { pipeline, gladys, registry } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });
  await learnThenType(pipeline, registry, 0.05);
  gladys.published.length = 0;

  await feed(pipeline, '20;2E;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  assert.deepEqual(gladys.published, [{ featureExternalId: `${SWITCH_ID}:cmd`, state: 1 }]);

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(gladys.published, [
    { featureExternalId: `${SWITCH_ID}:cmd`, state: 1 },
    { featureExternalId: `${SWITCH_ID}:cmd`, state: 0 },
  ]);
  pipeline.stop();
});

test('a new detection re-arms the delay instead of stacking timers', async () => {
  // A real PIR re-arms after several seconds, well beyond the repeat window;
  // the window is shrunk here so two genuine detections fit in a fast test.
  const { pipeline, gladys, registry } = setup({
    createdDevices: [{ external_id: SWITCH_ID }],
    duplicateWindowMs: 10,
  });
  await learnThenType(pipeline, registry, 0.2);
  gladys.published.length = 0;

  await feed(pipeline, '20;2E;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Still moving: a fresh detection, far enough apart not to be a radio repeat.
  await feed(pipeline, '20;2F;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(gladys.published.filter(({ state }) => state === 1).length, 2);
  assert.equal(
    gladys.published.filter(({ state }) => state === 0).length,
    0,
    'the first delay must be pushed back by the second detection, not fire under it',
  );

  // …and once the movement stops, the reset does happen.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(gladys.published.filter(({ state }) => state === 0).length, 1);
  pipeline.stop();
});

test('a switch is never reset behind the user back', async () => {
  const { pipeline, gladys } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });

  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(gladys.published, [{ featureExternalId: `${SWITCH_ID}:cmd`, state: 1 }]);
  pipeline.stop();
});

test('a past detection is not replayed onto a device added later', async () => {
  const { pipeline, gladys, registry } = setup();
  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  registry.setRole(SWITCH_ID, 'motion');
  gladys.devices = [{ external_id: SWITCH_ID }];

  await pipeline.handleDeviceKnown({ external_id: SWITCH_ID });

  // "Motion detected, ten minutes ago" is an event, not a state to restore.
  assert.deepEqual(gladys.published, []);
  pipeline.stop();
});

test('re-typing a device changes its Gladys category, not its feature key', async () => {
  const { pipeline, registry } = setup({ createdDevices: [{ external_id: SWITCH_ID }] });
  await feed(pipeline, '20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');

  const before = registry.buildDiscoveredDevices()[0].features[0];
  registry.setRole(SWITCH_ID, 'motion');
  const after = registry.buildDiscoveredDevices()[0].features[0];

  assert.equal(before.category, 'switch');
  assert.equal(after.category, 'motion-sensor');
  assert.equal(after.read_only, true);
  assert.equal(after.external_id, before.external_id, 'the history must survive the re-typing');
});

test('commandFor maps the controllable features and refuses the rest', () => {
  assert.equal(commandFor(RFLINK_FIELDS.CMD.key, 1), 'ON');
  assert.equal(commandFor(RFLINK_FIELDS.CMD.key, 0), 'OFF');
  assert.equal(commandFor(RFLINK_FIELDS.SET_LEVEL.key, 50), '8');
  assert.equal(commandFor(RFLINK_FIELDS.TEMP.key, 21), null);
});

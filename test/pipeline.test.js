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
function setup({ config = {}, createdDevices = [] } = {}) {
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
  });

  return { pipeline, gladys, registry, sent, changes };
}

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

test('commandFor maps the controllable features and refuses the rest', () => {
  assert.equal(commandFor(RFLINK_FIELDS.CMD.key, 1), 'ON');
  assert.equal(commandFor(RFLINK_FIELDS.CMD.key, 0), 'OFF');
  assert.equal(commandFor(RFLINK_FIELDS.SET_LEVEL.key, 50), '8');
  assert.equal(commandFor(RFLINK_FIELDS.TEMP.key, 21), null);
});

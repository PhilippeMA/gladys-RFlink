// -----------------------------------------------------------------------------
// The Configuration-screen buttons, against a fake gateway.
//
// The one that matters most is `declare_device`: it closes the gap the whole
// listening design leaves open — an address the gateway only ever TRANSMITS
// to, and has therefore never heard.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES as CATEGORIES } from '@gladysassistant/integration-sdk';

import { createActions } from '../src/actions.js';
import { createFakeGladys, createFakeStore } from './helpers/fakeGladys.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import { FRAME_KINDS, parseFrame } from '../src/rflink/protocol.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A gateway that behaves like RFLink: it answers `OK`, and for an echo line it
 * also replays the payload with a counter of its own.
 * @param {object} [options] - Options.
 * @param {boolean} [options.echoes] - Whether the firmware supports node 11.
 * @returns {object} `{ gateway, sent }`.
 */
function createFakeGateway({ echoes = true } = {}) {
  const sent = [];
  return {
    sent,
    gateway: {
      host: '192.168.1.42',
      port: 1234,
      async send(line) {
        sent.push(line);
      },
      async request(line, matcher) {
        sent.push(line);
        if (line.startsWith('11;') && echoes) {
          // RFLink strips the `11;20;00;` head and re-emits with its counter.
          const replayed = parseFrame(`20;D4;${line.split(';').slice(3).join(';')}`);
          if (matcher(replayed)) {
            return replayed;
          }
        }
        const ack = parseFrame('20;D3;OK;');
        if (matcher(ack)) {
          return ack;
        }
        throw new Error('No answer from the RFLink gateway after 8000 ms');
      },
    },
  };
}

/**
 * @param {object} [options] - Options.
 * @param {boolean} [options.echoes] - Whether the fake firmware echoes.
 * @param {object} [options.config] - Unused today, kept for symmetry.
 * @returns {object} The action handlers plus the pieces to assert on.
 */
function setup({ echoes = true } = {}) {
  const gladys = createFakeGladys();
  const registry = new DeviceRegistry({ gladys, store: createFakeStore(), logger: silent });
  const { gateway, sent } = createFakeGateway({ echoes });
  const published = [];
  const actions = createActions({
    gladys,
    getGateway: () => gateway,
    registry,
    publishDevices: async () => published.push(registry.buildDiscoveredDevices()),
  });
  return { actions, registry, sent, published, gladys };
}

test('declaring a shutter creates it without ever hearing it on the air', async () => {
  const { actions, registry, sent, published } = setup();

  const message = await actions.declare_device({
    protocol: 'RTS',
    id: 'A00001',
    unit: '0',
    command: 'STOP',
  });

  assert.deepEqual(sent, ['11;20;00;RTS;ID=a00001;SWITCH=0;CMD=STOP;']);
  assert.equal(registry.list().length, 1);
  // STOP is cover vocabulary, so the device is born correctly typed.
  assert.equal(registry.list()[0].role, 'shutter');
  assert.equal(published.length, 1);
  assert.equal(published[0][0].features[0].category, CATEGORIES.SHUTTER);
  assert.match(message.fr, /Découverte/);
});

test('declaring works even with automatic discovery switched off', async () => {
  // The user asked for THIS device by hand: the discovery switch must not veto
  // it, or the escape hatch would be closed exactly when it is needed.
  const { actions, registry } = setup();

  await actions.declare_device({ protocol: 'NewKaku', id: '00c142', unit: '1', command: 'OFF' });

  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].protocol, 'NewKaku');
});

test('a device with no unit is declared without a SWITCH field', async () => {
  const { actions, sent } = setup();

  await actions.declare_device({ protocol: 'RTS', id: 'a00002', command: 'STOP' });

  assert.deepEqual(sent, ['11;20;00;RTS;ID=a00002;CMD=STOP;']);
});

test('bad input is refused before anything reaches the gateway', async () => {
  const { actions, sent } = setup();

  await assert.rejects(actions.declare_device({ protocol: '', id: 'a1' }), /protocol name/);
  await assert.rejects(actions.declare_device({ protocol: 'RTS', id: 'nothex' }), /address/);
  await assert.rejects(
    actions.declare_device({ protocol: 'RTS', id: 'a1', unit: 'way-too-long' }),
    /unit number/,
  );
  await assert.rejects(
    actions.declare_device({ protocol: 'RTS', id: 'a1', command: 'EXPLODE' }),
    /Unsupported command/,
  );
  assert.deepEqual(sent, [], 'nothing may be transmitted on invalid input');
});

test('a firmware without the echo node fails with an actionable message', async () => {
  const { actions, registry } = setup({ echoes: false });

  await assert.rejects(
    actions.declare_device({ protocol: 'RTS', id: 'a00001', command: 'STOP' }),
    /recent RFLink firmware/,
  );
  assert.equal(registry.list().length, 0);
});

test('the version action survives a firmware that answers in free text', async () => {
  // The reference documents the reply as `20;99;"software version";`, while
  // real firmwares send `VER=`/`REV=`. Timing out on the documented shape
  // would be the worst of both.
  const { actions } = setup();
  const gladys = createFakeGladys();
  const freeText = parseFrame('20;99;Nodo RadioFrequencyLink - RFLink Gateway V1.1 - R48;');
  assert.equal(freeText.kind, FRAME_KINDS.STATUS);

  const handlers = createActions({
    gladys,
    getGateway: () => ({
      host: 'h',
      port: 1,
      async request(_line, matcher) {
        if (matcher(freeText)) {
          return freeText;
        }
        throw new Error('no answer');
      },
    }),
    registry: {},
    publishDevices: async () => {},
  });

  const message = await handlers.gateway_version();
  assert.match(message.en, /R48/);
  assert.ok(actions.gateway_version, 'the handler is still registered');
});

test('every action refuses to run without a configured gateway', async () => {
  const handlers = createActions({
    gladys: {},
    getGateway: () => null,
    registry: {},
    publishDevices: async () => {},
  });
  await assert.rejects(handlers.test_connection(), /No RFLink gateway configured/);
  await assert.rejects(handlers.declare_device({ protocol: 'RTS', id: 'a1' }), /No RFLink gateway/);
});

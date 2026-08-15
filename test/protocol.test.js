import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSafeCommand,
  buildDeviceCommand,
  FRAME_KINDS,
  parseDecimal,
  parseFrame,
  parseHex,
  parseSignedTemperature,
} from '../src/rflink/protocol.js';

test('parses a switch frame into a device identity plus its measurements', () => {
  const frame = parseFrame('20;2D;NewKaku;ID=000005;SWITCH=2;CMD=ON;');
  assert.equal(frame.kind, FRAME_KINDS.DEVICE);
  assert.equal(frame.counter, '2D');
  assert.equal(frame.protocol, 'NewKaku');
  assert.equal(frame.id, '000005');
  assert.equal(frame.unit, '2');
  assert.deepEqual(frame.values, { CMD: 'ON' });
});

test('a sensor frame has no SWITCH and keeps every measurement', () => {
  const frame = parseFrame('20;9F;Oregon TempHygro;ID=0710;TEMP=00b4;HUM=44;BAT=OK;');
  assert.equal(frame.kind, FRAME_KINDS.DEVICE);
  assert.equal(frame.unit, null);
  assert.deepEqual(frame.values, { TEMP: '00b4', HUM: '44', BAT: 'OK' });
});

test('a protocol name containing spaces stays intact', () => {
  const frame = parseFrame('20;12;Alecto V4;ID=00f0;WINSP=0032;WINDIR=04;');
  assert.equal(frame.protocol, 'Alecto V4');
});

test('recognizes the gateway answers that carry no device', () => {
  assert.equal(parseFrame('20;06;OK;').kind, FRAME_KINDS.ACK);
  assert.equal(parseFrame('20;07;PONG;').kind, FRAME_KINDS.PONG);
  assert.equal(parseFrame('20;09;CMD UNKNOWN;').kind, FRAME_KINDS.ERROR);

  const version = parseFrame('20;08;VER=1.1;REV=48;BUILD=07;');
  assert.equal(version.kind, FRAME_KINDS.VERSION);
  assert.deepEqual(version.values, { VER: '1.1', REV: '48', BUILD: '07' });

  const banner = parseFrame('20;00;Nodo RadioFrequencyLink - RFLink Gateway V1.1 - R48;');
  assert.equal(banner.kind, FRAME_KINDS.BANNER);
  assert.match(banner.message, /RFLink Gateway/);
});

test('a line without an ID never becomes a device', () => {
  // A settings dump must not create a phantom device in the Discovery screen.
  const frame = parseFrame('20;11;STATUS;setRF433=ON;setNodo=OFF;');
  assert.equal(frame.kind, FRAME_KINDS.STATUS);
  assert.equal(frame.protocol, undefined);
});

test('ignores anything that is not an inbound RFLink line', () => {
  assert.equal(parseFrame(''), null);
  assert.equal(parseFrame('   '), null);
  assert.equal(parseFrame('10;NewKaku;000005;2;ON;'), null); // our own echo
  assert.equal(parseFrame('random garbage'), null);
  assert.equal(parseFrame('20;2D;'), null);
  assert.equal(parseFrame(undefined), null);
});

test('the dim level nested in CMD survives the generic KEY=VALUE split', () => {
  // RFLink writes `CMD=SET_LEVEL=13`; splitting on the FIRST '=' must keep
  // the whole right-hand side (featureMap.js then unfolds it).
  const frame = parseFrame('20;05;NewKaku;ID=00c142;SWITCH=1;CMD=SET_LEVEL=13;');
  assert.deepEqual(frame.values, { CMD: 'SET_LEVEL=13' });
});

test('builds the four positional fields of a device command', () => {
  assert.equal(
    buildDeviceCommand({ protocol: 'NewKaku', id: '00c142', unit: '1' }, 'ON'),
    '10;NewKaku;00c142;1;ON;',
  );
  // A device without a unit still needs the field: RFLink accepts 0.
  assert.equal(
    buildDeviceCommand({ protocol: 'Kaku', id: '000041', unit: null }, 'OFF'),
    '10;Kaku;000041;0;OFF;',
  );
  assert.equal(
    buildDeviceCommand({ protocol: 'NewKaku', id: '00c142', unit: '1' }, 12),
    '10;NewKaku;00c142;1;12;',
  );
});

test('a raw command is accepted only as a single 10; line', () => {
  assert.equal(assertSafeCommand('  10;PING;  '), '10;PING;');
  assert.throws(() => assertSafeCommand(''), /Empty command/);
  assert.throws(() => assertSafeCommand('20;06;OK;'), /must start with "10;"/);
  // The important one: a newline would inject a second, unreviewed command.
  assert.throws(() => assertSafeCommand('10;PING;\n10;REBOOT;'), /single line/);
  assert.throws(() => assertSafeCommand(`10;${'X'.repeat(200)};`), /at most/);
});

test('reads hexadecimal and decimal fields, and refuses the other one', () => {
  assert.equal(parseHex('00b4'), 180);
  assert.equal(parseHex('FF'), 255);
  assert.equal(parseHex('12g4'), null);
  assert.equal(parseDecimal('44'), 44);
  assert.equal(parseDecimal('-3'), -3);
  // 'b4' is valid hex but not decimal: the table decides which reader applies.
  assert.equal(parseDecimal('00b4'), null);
});

test('a temperature carries its sign in the high bit, not in two complement', () => {
  assert.equal(parseSignedTemperature('00b4'), 18);
  assert.equal(parseSignedTemperature('80b4'), -18);
  assert.equal(parseSignedTemperature('00d9'), 21.7);
  assert.equal(parseSignedTemperature('0000'), 0);
  assert.equal(parseSignedTemperature('zzz'), null);
});

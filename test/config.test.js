import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProtocolFilter,
  DEFAULT_CONFIG,
  isConfigured,
  normalizeConfig,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps the user values over the defaults', () => {
  const config = normalizeConfig({ host: '192.168.1.42', port: 2345 });
  assert.equal(config.host, '192.168.1.42');
  assert.equal(config.port, 2345);
});

test('normalizeConfig coerces the strings a form sends', () => {
  const config = normalizeConfig({ host: '  rflink.local  ', port: '1234' });
  assert.equal(config.host, 'rflink.local');
  assert.equal(config.port, 1234);
  assert.equal(typeof config.port, 'number');
});

test('an unusable port falls back to the default instead of crashing net.connect', () => {
  assert.equal(normalizeConfig({ port: 'abc' }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 0 }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 70000 }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 1234.5 }).port, DEFAULT_CONFIG.port);
});

test('auto-discovery is on unless explicitly disabled', () => {
  assert.equal(normalizeConfig().auto_discover, true);
  assert.equal(normalizeConfig({ auto_discover: true }).auto_discover, true);
  assert.equal(normalizeConfig({ auto_discover: false }).auto_discover, false);
});

test('raw frame logging is off unless explicitly enabled', () => {
  assert.equal(normalizeConfig().debug_frames, false);
  assert.equal(normalizeConfig({ debug_frames: true }).debug_frames, true);
  assert.equal(normalizeConfig({ debug_frames: 'yes' }).debug_frames, false);
});

test('the integration is configured once it has a gateway address', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ host: '   ' })), false);
  assert.equal(isConfigured(normalizeConfig({ host: '192.168.1.42' })), true);
});

test('the ignore list matches protocol names case-insensitively', () => {
  const isIgnored = buildProtocolFilter(
    normalizeConfig({ ignored_protocols: 'Oregon TempHygro, cresta ,, ' }),
  );
  assert.equal(isIgnored('Oregon TempHygro'), true);
  assert.equal(isIgnored('oregon temphygro'), true);
  assert.equal(isIgnored('Cresta'), true);
  assert.equal(isIgnored('NewKaku'), false);
  assert.equal(isIgnored(undefined), false);
});

test('an empty ignore list ignores nothing', () => {
  const isIgnored = buildProtocolFilter(normalizeConfig());
  assert.equal(isIgnored('NewKaku'), false);
  assert.equal(isIgnored(''), false);
});

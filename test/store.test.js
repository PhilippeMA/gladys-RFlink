import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JsonStore } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @returns {Promise<string>} A fresh temporary file path.
 */
async function temporaryFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'rflink-store-'));
  return path.join(directory, 'nested', 'devices.json');
}

test('writes and reads back, creating the directory on the way', async () => {
  const store = new JsonStore(await temporaryFile(), { logger: silent });
  assert.equal(await store.write({ version: 1, devices: [{ id: 'a' }] }), true);
  assert.deepEqual(await store.read(), { version: 1, devices: [{ id: 'a' }] });
});

test('a missing file reads as the fallback, not as an error', async () => {
  const store = new JsonStore(await temporaryFile(), { logger: silent });
  assert.equal(await store.read(), null);
  assert.deepEqual(await store.read({ devices: [] }), { devices: [] });
});

test('a corrupt file degrades to the fallback instead of blocking the startup', async () => {
  const filePath = await temporaryFile();
  const store = new JsonStore(filePath, { logger: silent });
  await store.write({});
  await writeFile(filePath, '{ this is not json', 'utf8');

  assert.deepEqual(await store.read({ devices: [] }), { devices: [] });
});

test('an unwritable path is reported as a failure, never thrown', async () => {
  // A read-only /data (or a volume that failed to mount) must degrade the
  // integration, not crash it. Nesting a directory under a regular FILE is the
  // portable way to make the write fail.
  const blocker = await temporaryFile();
  await new JsonStore(blocker, { logger: silent }).write({});
  const store = new JsonStore(path.join(blocker, 'devices.json'), { logger: silent });

  assert.equal(await store.write({ devices: [] }), false);
});

test('scheduled writes coalesce, and flush persists them immediately', async () => {
  const filePath = await temporaryFile();
  const store = new JsonStore(filePath, { logger: silent, writeDelayMs: 5_000 });

  store.scheduleWrite({ devices: ['first'] });
  store.scheduleWrite({ devices: ['second'] });
  assert.equal(await store.read(), null, 'nothing hit the disk while debounced');

  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { devices: ['second'] });
});

test('flushing with nothing pending is a no-op', async () => {
  const store = new JsonStore(await temporaryFile(), { logger: silent });
  await store.flush();
  assert.equal(await store.read(), null);
});

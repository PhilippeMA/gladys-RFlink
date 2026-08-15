// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest shape is validated by the store indexer, but nothing there can
// know which handlers the code registers or which defaults it assumes — these
// tests keep the two in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createActions } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const actionKeys = Object.keys(
  createActions({
    gladys: {},
    getGateway: () => null,
    registry: {},
    publishDevices: async () => {},
  }),
);

test('every manifest action has a registered handler, and vice versa', () => {
  const declared = (manifest.actions ?? []).map((action) => action.key);
  assert.deepEqual([...declared].sort(), [...actionKeys].sort());
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every value-carrying config field is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config field "${field.key}" has no entry in DEFAULT_CONFIG`,
    );
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // Older cores reject any unknown manifest field, so a manifest declaring
  // `categories` must not claim compatibility below the first release that
  // accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the manifest version and the docker image tag stay in lockstep', () => {
  // The release workflow bumps both; a hand edit that forgets one would make
  // the indexer serve a version whose image does not exist.
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image "${manifest.docker_image}" does not carry version ${manifest.version}`,
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must have no placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the identify action targets a device through the dynamic select', () => {
  const identify = manifest.actions.find((action) => action.key === 'identify');
  const [field] = identify.fields;
  assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
  assert.equal(
    field.options,
    undefined,
    'declaring source and options together rejects the manifest',
  );
});

test('every user-facing label is translated in both languages', () => {
  const texts = [];
  const collect = (field) => {
    for (const key of ['label', 'description', 'placeholder']) {
      if (field[key] !== undefined) {
        texts.push([field.key, key, field[key]]);
      }
    }
  };
  manifest.config_schema.forEach(collect);
  for (const action of manifest.actions) {
    collect(action);
    (action.fields ?? []).forEach(collect);
  }
  texts.push(['manifest', 'description', manifest.description]);

  for (const [owner, key, text] of texts) {
    assert.ok(text.en, `${owner}.${key} is missing its English text`);
    assert.ok(text.fr, `${owner}.${key} is missing its French text`);
  }
});

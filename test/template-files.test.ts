import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { templateFiles } from './template-files';

test('template discovery includes arbitrary new repositories and nested templates, ignoring generated directories', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'snf-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = ['existing-db/first.snf', 'new-db/nested/second.snf'];
  for (const name of [...names, 'new-db/notes.txt', 'new-db/.git/ignored.snf', 'new-db/node_modules/ignored.snf', 'new-db/dist/ignored.snf']) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'SELECT value');
  }
  assert.deepEqual(templateFiles(root), names.map(name => path.join(root, name)));
});

test('empty or missing template directories fail rather than silently skipping integration checks', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'snf-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => templateFiles(root), /No SNF templates found/);
  assert.throws(() => templateFiles(path.join(root, 'missing')), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import { SNFDocumentParser, NodeType as T } from '../src/index';
import { nodes } from './helpers';
const roots = ['mysql', 'postgres', 'oracle', 'sqlserver'].map(r =>
  path.resolve(import.meta.dirname, '../..', r),
);
const files = await glob(
  roots.map(r => path.join(r, '**/*.snf')),
  { nodir: true },
);
let count = 0;
for (const file of files) {
  const source = await fs.readFile(file, 'utf8'),
    parser = new SNFDocumentParser(),
    doc = parser.parse(source);
  assert.equal(doc.lines.map(l => l.content + l.ending).join(''), source);
  const items = [...doc.entries, ...doc.definitions],
    all = items.flatMap(x => nodes(x.ast));
  const ids = all.map(n => n.uid);
  assert.equal(new Set(ids).size, ids.length, file);
  const targets = new Set(doc.definitions.map(d => d.ast.uid));
  for (const node of all) {
    assert.match(node.uid!, /^[A-Z]{2}[0-9A-F]{2}-[0-9A-F]{4}-[0-9A-F]{32}-[0-9A-F]{4}$/);
    if (!node.synthetic)
      assert.equal(doc.blocks[node.sourceBlock!].content.slice(node.start, node.end), node.raw, file);
    if (node.type === T.REFERENCE) assert.ok(targets.has(node.target), file);
    assert.ok(![T.REPEAT, T.SPLIT, T.QUOTE, T.DOUBLEQUOTE].includes(node.type), file);
  }
  const second = parser.parse(source);
  assert.deepEqual(
    [...second.entries, ...second.definitions].flatMap(x => nodes(x.ast)).map(n => n.uid),
    ids,
    file,
  );
  count += ids.length;
}
console.log(
  `Full repositories passed: ${files.length} files, ${count} final AST nodes; spans, unique IDs, resolved references and repeatability.`,
);

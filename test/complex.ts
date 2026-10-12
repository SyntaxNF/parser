import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findIdentityCollisions, SNFDocumentParser, NodeType as T } from '../src/index';
import { nodes } from './helpers';
const roots = ['mysql', 'postgresql', 'oracle', 'sqlserver'].map(r =>
  path.resolve(import.meta.dirname, '../..', r),
);
async function snfFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await snfFiles(file));
    else if (entry.name.endsWith('.snf')) files.push(file);
  }
  return files;
}
const files = (await Promise.all(roots.map(snfFiles))).flat().sort();
let count = 0;
let sameSignatureCount = 0;
let fullBytes = 0, simpleBytes = 0;
const shortHashCollisions: unknown[] = [];
for (const file of files) {
  const source = await fs.readFile(file, 'utf8'),
    parser = new SNFDocumentParser(),
    doc = parser.parse(source);
  assert.equal(doc.lines.map(l => l.content + l.ending).join(''), source);
  const items = [...doc.entries, ...doc.definitions],
    all = items.flatMap(x => nodes(x.ast));
  const ids = all.map(n => n.uid);
  for (const collision of findIdentityCollisions(items.map(item => item.ast))) {
    if (collision.kind === 'short-hash') shortHashCollisions.push({ file, ...collision });
    else sameSignatureCount++;
  }
  assert.equal(new Set(ids).size, ids.length, file);
  const targets = new Set(doc.definitions.map(d => d.ast.uid));
  for (const node of all) {
    assert.match(node.uid!, /^[A-Z]{2}[0-9A-F]{2}-[0-9A-F]{4}-[0-9A-F]{32}-[0-9A-F]{4}$/);
    if (node.indentLevel !== undefined)
      assert.ok(Number.isInteger(node.indentLevel) && node.indentLevel >= 0, `${file}: invalid template indentation`);
    if (!node.synthetic)
      assert.equal(doc.blocks[node.sourceBlock!].content.slice(node.start, node.end), node.raw, file);
    if (node.type === T.REFERENCE) assert.ok(targets.has(node.target), file);
    assert.ok(![T.REPEAT, T.SPLIT].includes(node.type), file);
  }
  const second = parser.parse(source);
  assert.deepEqual(
    [...second.entries, ...second.definitions].flatMap(x => nodes(x.ast)).map(n => n.uid),
    ids,
    file,
  );
  const simple = parser.parse(source, { simple: true });
  const simpleNodes = [...simple.entries, ...simple.definitions].flatMap(item => {
    const all = [], pending = [item.ast];
    while (pending.length) {
      const node = pending.pop()!;
      all.push(node);
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) pending.push(node.children![index]);
    }
    return all;
  });
  assert.deepEqual(simpleNodes.map(node => node.uid), ids, `${file}: simple mode UID mismatch`);
  for (const field of ['content', 'lines', 'blocks']) assert.equal(Object.hasOwn(simple, field), false, file);
  for (const node of simpleNodes)
    for (const field of ['raw', 'start', 'end', 'sourceBlock', 'synthetic']) assert.equal(Object.hasOwn(node, field), false, file);
  const simpleTargets = new Set(simple.definitions.map(definition => definition.ast.uid));
  for (const node of simpleNodes) if (node.type === T.REFERENCE) assert.ok(simpleTargets.has(node.target), file);
  fullBytes += Buffer.byteLength(JSON.stringify(doc));
  simpleBytes += Buffer.byteLength(JSON.stringify(simple));
  count += ids.length;
}
console.log(
  `Full repositories passed: ${files.length} files, ${count} final AST nodes; indentation, spans, unique IDs, resolved references and repeatability.`,
);
console.log(
  `Boundary collision audit: ${sameSignatureCount} same-signature prefixes (ordinal fallback), ${shortHashCollisions.length} short-hash collisions.`,
);
console.log(`Simple JSON: ${fullBytes} -> ${simpleBytes} bytes (${(100 * (1 - simpleBytes / fullBytes)).toFixed(1)}% smaller), same UIDs and recursive targets.`);
assert.deepEqual(
  shortHashCollisions, [], 'Four-digit feature hashes introduced order-sensitive boundary identities',
);

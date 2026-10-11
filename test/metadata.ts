import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SNFParser, SNFDocumentParser, SNFParseError, NodeType as T, Node } from '../src/index';
import { nodes } from './helpers';
function checkMetadata(roots: Node[]) {
  const all = roots.flatMap(nodes);
  for (const n of all) {
    assert.match(n.uid!, /^[A-Z]{2}[0-9A-F]{2}-[0-9A-F]{4}-[0-9A-F]{32}-[0-9A-F]{4}$/);
    if ([T.VARIABLE, T.OPTIONAL, T.ENUM, T.LOOP, T.REFERENCE, T.STATEMENT].includes(n.type))
      assert.ok(n.name);
    assert.equal(Object.hasOwn(n, 'ast'), false);
  }
  assert.equal(new Set(all.map(n => n.uid)).size, all.length);
}
test('metadata is complete on final structures, document sessions reset', () => {
  const source = 'MODE { A | B }\n\n{ A | B }\n\nitem [, ...]';
  const parser = new SNFDocumentParser(),
    doc = parser.parse(source);
  checkMetadata(doc.entries.map(e => e.ast));
  assert.deepEqual(parser.parse(source), doc);
  assert.deepEqual(parser.parse('').entries, []);
  assert.deepEqual(parser.parse(source), doc);
});
test('failed parses and parser reuse never leak metadata', () => {
  for (const p of [new SNFParser(), new SNFDocumentParser()]) {
    const first = p.parse('MODE { A | B }');
    assert.throws(() => p.parse('[ A | B ]'), SNFParseError);
    assert.deepEqual(p.parse('MODE { A | B }'), first);
  }
});

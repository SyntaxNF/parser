import assert from 'node:assert/strict';
import { SNFParser, SNFDocumentParser, SNFParseError, NodeType as T } from '../src/index';
import { nodes } from './helpers';
const parse = (s: string) => new SNFParser().parse(s);
for (const source of [
  'CREATE [OR REPLACE] FUNCTION name ([arg[, ...]])',
  'table.colname',
  '{ 0 | 1 | 123 }',
  '[ LIMIT count ]',
  '[ { ASC | DESC } ]',
  '[ [ a ] ]',
  '{ A }',
  String.raw`[ a\|b ]`,
  String.raw`[ \[ \{ \| \} \] ]`,
]) {
  for (const node of nodes(parse(source))) assert.equal(node.raw, source.slice(node.start, node.end));
}
assert.deepEqual(
  nodes(parse('{ 0 | 1 | 123 }'))
    .filter(n => n.type === T.NUMBER)
    .map(n => n.content),
  ['0', '1', '123'],
);
assert.equal(
  nodes(parse('[ LIMIT count ]')).some(n => n.type === T.ENUM),
  false,
);
assert.equal(nodes(parse('[ { ASC | DESC } ]')).filter(n => n.type === T.GROUP).length, 2);
assert.deepEqual(
  nodes(parse('[ value as item ]'))
    .filter(n => n.type === T.VARIABLE)
    .map(n => n.content),
  ['value', 'as', 'item'],
);
for (const source of [
  'A | B',
  '[ A | B ]',
  '{ [ A | B ] }',
  '[ { A | B } | C ]',
  'item [, ... | other]',
  '{ | A || }',
  'name\\',
  '{ A } }',
  '[ A',
  '[....]',
  'item ...',
  '[...]',
  'ANY [...]',
  '(item) [...]',
])
  assert.throws(() => parse(source), SNFParseError);
assert.throws(
  () => parse('[ A\n  | B ]'),
  (e: unknown) => e instanceof SNFParseError && e.line === 2 && e.column === 3,
);
const source = '# https://example.com/syntax\r\n\r\n# PARTOFIS item\r\nFIRST value\r\n\r\nSECOND value';
const doc = new SNFDocumentParser().parse(source);
assert.equal(doc.lines.map(l => l.content + l.ending).join(''), source);
assert.equal(doc.blocks.length, 3);
for (const b of doc.blocks)
  assert.equal(source.slice(b.start, b.end), b.lines.map(l => l.content + l.ending).join(''));
console.log('Base parser tests passed.');

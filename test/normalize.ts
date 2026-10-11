import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SNFParser, NodeType as T } from '../src/index';
import { nodes } from './helpers';

test('quoted sequences and empty literals survive; loops include whole quoted member', () => {
  for (const source of [`'a  b' [, ...]`, `''`, `'A "b" C'`, `"A 'b' C"`]) {
    const n = nodes(new SNFParser().parse(source));
    assert.equal(n.filter(n => n.type === T.QUOTED).length, 1);
    assert.ok(!n.some(n => [T.QUOTE, T.DOUBLEQUOTE, T.REPEAT].includes(n.type)));
    for (const node of n) assert.equal(node.raw, source.slice(node.start, node.end));
  }
  assert.throws(() => new SNFParser().parse("'a"), /Unclosed quote/);
});
test('SQL doubled quotes stay inside one complete repeated member', () => {
  for (const source of ["'IT''S' [, ...]", '"A""B" [, ...]', "'''' [, ...]", "'' [, ...]"]) {
    const ast = new SNFParser().parse(source);
    assert.equal(ast.children!.length, 1);
    const loop = ast.children![0];
    assert.equal(loop.type, T.LOOP);
    assert.equal(loop.children![0].type, T.QUOTED);
    assert.equal(loop.children![0].raw, source.slice(0, source.indexOf(' [, ...]')));
    for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
  }
  for (const source of ["'''", "'A''"]) assert.throws(() => new SNFParser().parse(source), /Unclosed quote/);
  const separated = new SNFParser().parse("'A' 'B' [, ...]");
  assert.equal(separated.children![0].type, T.QUOTED);
  assert.equal(separated.children!.at(-1)!.children![0].raw, "'B'");
});

test('quoted context reaches nested optional and enum syntax without leaking', () => {
  for (const source of [`MODE 'PREFIX [ "suffix ]' { A | B }`, `MODE "PREFIX [ 'suffix ]" { A | B }`]) {
    const ast = new SNFParser().parse(source);
    assert.equal(nodes(ast).filter(n => n.type === T.QUOTED).length, 1);
    assert.equal(nodes(ast).find(n => n.type === T.ENUM)!.name, 'MODE');
    assert.ok(nodes(ast).some(n => n.type === T.OTHER && ['"', "'"].includes(n.content)));
  }
});

test('loop separator formatting preserves metadata but quoted whitespace remains significant', () => {
  const loop = (source: string) => nodes(new SNFParser().parse(source)).find(n => n.type === T.LOOP)!;
  const before = loop('ITEM x [ OR ELSE ... ]');
  const after = loop('ITEM renamed [ OR\n\tELSE ... ]');
  assert.equal(before.separator, 'OR ELSE');
  assert.equal(after.separator, before.separator);
  assert.equal(after.uid, before.uid);
  assert.equal(after.name, before.name);
  assert.equal(after.children![0].uid, before.children![0].uid);
  assert.notEqual(loop("'x [ OR ELSE ... ]'").uid, loop("'x [ OR  ELSE ... ]'").uid);
});

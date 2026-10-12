import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SNFParser, SNFDocumentParser, SNFParseError, NodeType as T } from '../src/index';
import { nodes } from './helpers';

test('quoted sequences and empty literals survive; loops include whole quoted member', () => {
  for (const source of [`'a  b' [, ...]`, `''`, `""`]) {
    const n = nodes(new SNFParser().parse(source));
    assert.equal(n.filter(n => n.type === T.QUOTED).length, 1);
    assert.ok(!n.some(n => n.type === T.REPEAT));
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

test('quote containers parse nested syntax like optional containers', () => {
  const body = 'A value [ LIMIT count ] { ASC | DESC } item [ OR ELSE ... ]';
  const children = (source: string) => JSON.parse(JSON.stringify(
    new SNFParser().parse(source).children![0].children,
    (key, value) => key === 'uid' || key === 'name' ? undefined : value,
  ));
  for (const quote of ["'", '"']) assert.deepEqual(children(quote + body + quote), children('[' + body + ']'));
});

test('nested quotes form containers and do not leak their keyword context', () => {
  for (const source of [
    `MODE 'PREFIX [ "suffix" ]' { A | B }`,
    `MODE "PREFIX [ 'suffix' ]" { A | B }`,
    `MODE 'PREFIX [ 'suffix' ]' { A | B }`,
    `MODE "PREFIX [ "suffix" ]" { A | B }`,
    `MODE 'A "b" C' { A | B }`,
    `MODE "A 'b' C" { A | B }`,
  ]) {
    const ast = new SNFParser().parse(source);
    assert.equal(nodes(ast).filter(n => n.type === T.QUOTED).length, 2);
    assert.equal(nodes(ast).find(n => n.type === T.ENUM)!.name, 'MODE');
    for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
  }
});

test('quotes enforce their own closing boundaries and allow escaped delimiters', () => {
  for (const source of [
    `'A [ "suffix ]'`,
    `"A [ 'suffix ]"`,
    `'A [ B' ]`,
    `"A { B | C" }`,
    `'A | B'`,
    `'A ]'`,
  ]) assert.throws(() => new SNFParser().parse(source), SNFParseError);
  for (const source of [String.raw`'A \" B'`, String.raw`"A \' B"`, String.raw`'A \[ \| \] B'`]) {
    const ast = new SNFParser().parse(source);
    assert.equal(nodes(ast).filter(n => n.type === T.QUOTED).length, 1);
    for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
  }
  const source = '# CASE A\r\nSELECT \'value';
  assert.throws(() => new SNFDocumentParser().parse(source), (error: unknown) =>
    error instanceof SNFParseError && error.offset === source.length && error.line === 2 && error.expected === "'",
  );
});

test('loop separator formatting uses the same rules inside quotes and optional containers', () => {
  const loop = (source: string) => nodes(new SNFParser().parse(source)).find(n => n.type === T.LOOP)!;
  const before = loop('ITEM x [ OR ELSE ... ]');
  const after = loop('ITEM renamed [ OR\n\tELSE ... ]');
  assert.equal(before.separator, 'OR ELSE');
  assert.equal(after.separator, before.separator);
  assert.equal(after.uid, before.uid);
  assert.equal(after.name, before.name);
  assert.equal(after.children![0].uid, before.children![0].uid);
  const quotedBefore = loop("'x [ OR ELSE ... ]'");
  const quotedAfter = loop("'x [ OR\n\t ELSE ... ]'");
  assert.equal(quotedAfter.separator, before.separator);
  assert.equal(quotedAfter.uid, quotedBefore.uid);
  assert.equal(quotedAfter.children![0].uid, quotedBefore.children![0].uid);
  for (const wrapper of ["'", '"', '[']) {
    const closing = wrapper === '[' ? ']' : wrapper;
    assert.equal(loop(wrapper + 'item[,  ...]' + closing).separator, ',');
    assert.equal(loop(wrapper + 'item[ \n\t ...]' + closing).separator, '');
  }
});

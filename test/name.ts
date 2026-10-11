import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, NodeType as T, SNFParser, SNFDocumentParser } from '../src/index';
import { createIdentityAllocator } from '../src/internal/identity';
import { nodes } from './helpers';
const parse = (source: string) => new SNFParser().parse(source);

const names = (root: Node, type: T) =>
  nodes(root)
    .filter(node => node.type === type)
    .map(node => node.name);

test('parser names use the complete keyword run and survive renaming, formatting and feature reordering', () => {
  const a = parse('FORMAT { JSON | XML } ORDER BY column [, ...]');
  const b = parse('ORDER\n BY renamed [, ...] FORMAT { XML | JSON }');
  assert.deepEqual(names(a, T.ENUM), ['FORMAT']);
  assert.deepEqual(names(a, T.LOOP), ['ORDER_BY']);
  assert.deepEqual(names(b, T.ENUM), names(a, T.ENUM));
  assert.deepEqual(names(b, T.LOOP), names(a, T.LOOP));
});

test('unnamed context uses type labels independent of candidates and repeated variables', () => {
  for (const source of ['{ A | B } item [, ...]', '{ B | C | A } renamed [, ...]']) {
    const ast = parse(source);
    assert.deepEqual(names(ast, T.ENUM), ['ENUM']);
    assert.deepEqual(names(ast, T.LOOP), ['LOOP']);
  }
});

test('nested scopes inherit, replace and restore context; enum branches are isolated', () => {
  const a = parse('OUTER { INNER { A | B } | { C | D } } item [, ...]');
  const b = parse('OUTER { { D | C } | INNER { B | A } } renamed [, ...]');
  assert.deepEqual(names(a, T.ENUM), ['OUTER', 'INNER', 'OUTER']);
  assert.deepEqual(names(b, T.ENUM), ['OUTER', 'OUTER', 'INNER']);
  assert.deepEqual(names(a, T.LOOP), ['OUTER']);
  assert.deepEqual(names(b, T.LOOP), ['OUTER']);
  assert.deepEqual(names(parse('SELECT [ ORDER BY item [, ...] ] value [, ...]'), T.LOOP), [
    'ORDER_BY',
    'SELECT',
  ]);
});

test('same-context names may repeat without ordinal suffixes', () => {
  const result = parse('MODE { A | B } { C | D } item [, ...]');
  assert.deepEqual(names(result, T.ENUM), ['MODE', 'MODE']);
  assert.deepEqual(names(result, T.LOOP), ['MODE']);
  const inserted = parse('MODE { X | Y } { A | B } { C | D } item [, ...]');
  assert.deepEqual(names(inserted, T.ENUM), ['MODE', 'MODE', 'MODE']);
});

test('quoted definitions do not replace the external naming context', () => {
  for (const source of [
    `MODE 'INNER WORD' { A | B } item [, ...]`,
    'MODE "INNER WORD" { A | B } item [, ...]',
  ]) {
    const ast = parse(source);
    assert.deepEqual(names(ast, T.ENUM), ['MODE']);
    assert.deepEqual(names(ast, T.LOOP), ['MODE']);
  }
  assert.deepEqual(names(parse('MODE "INNER" BY { A | B }'), T.ENUM), ['BY']);
});

test('each document entry starts with an empty naming context', () => {
  const document = new SNFDocumentParser().parse('MODE { A | B }\n\n{ C | D }\n\nitem [, ...]');
  assert.deepEqual(
    document.entries.map(entry =>
      nodes(entry.ast)
        .filter(n => n.name)
        .map(n => n.name),
    ),
    [['MODE'], ['ENUM'], ['LOOP', 'item']],
  );
});

test('UID reassignment preserves caller names without using them as identity', () => {
  const input = parse('MODE { A | B } COLUMNS item [, ...]');
  const originalIds = nodes(createIdentityAllocator()(input)).map(n => n.uid);
  nodes(input).find(n => n.type === T.ENUM)!.name = 'custom';
  const before = structuredClone(input);
  const result = createIdentityAllocator()(input);
  assert.deepEqual(input, before);
  assert.deepEqual(names(result, T.ENUM), ['custom']);
  assert.deepEqual(names(result, T.LOOP), ['COLUMNS']);
  assert.deepEqual(
    nodes(result).map(n => n.uid),
    originalIds,
  );
  assert.equal(nodes(result).find(n => n.type === T.VARIABLE)!.name, 'item');
});

test('VARIABLE names retain their own content and case while UIDs survive renaming', () => {
  const before = parse('ORDER BY first, second [ LIMIT count ] [ OFFSET position ]');
  const after = parse('ORDER\nBY renamed, other [ OFFSET pos ] [ LIMIT size ]');
  assert.deepEqual(names(before, T.VARIABLE), ['first', 'second', 'count', 'position']);
  assert.deepEqual(names(after, T.VARIABLE), ['renamed', 'other', 'pos', 'size']);
  assert.deepEqual(names(parse('value'), T.VARIABLE), ['value']);
  assert.equal(nodes(before).find(n => n.type === T.VARIABLE)!.content, 'first');
  assert.equal(
    nodes(parse('SELECT first')).find(n => n.type === T.VARIABLE)!.uid,
    nodes(parse('SELECT renamed')).find(n => n.type === T.VARIABLE)!.uid,
  );
  assert.deepEqual(names(parse(String.raw`value\X`), T.VARIABLE), ['valueX']);
});

test('OPTIONAL names use the first direct fixed descriptor without borrowing outer context or nested candidates', () => {
  for (const [source, expected] of [
    ['[ LIMIT count ]', 'LIMIT'],
    ['[ ORDER BY column ]', 'ORDER'],
    ['[ value = other ]', '='],
    ['[ 10 value ]', '10'],
    ['SELECT [ value ]', 'OPTIONAL'],
    ['SELECT [ { A | B } ]', 'OPTIONAL'],
  ])
    assert.deepEqual(names(parse(source), T.OPTIONAL), [expected]);
  const before = parse('SELECT [ LIMIT count ] [ OFFSET pos ]');
  const after = parse('SELECT [ OFFSET renamed ] [ LIMIT other ]');
  assert.deepEqual(names(before, T.OPTIONAL), ['LIMIT', 'OFFSET']);
  assert.deepEqual(names(after, T.OPTIONAL), ['OFFSET', 'LIMIT']);
});

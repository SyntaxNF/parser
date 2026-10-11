import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { findIdentityCollisions, Node, NodeType as T, SNFDocumentParser, SNFParser } from '../src/index';
import { collectLocalFeatures } from '../src/internal/boundary-identity';
import { createIdentityAllocator } from '../src/internal/identity';
import { shortCode, hash256 } from '../src/internal/hash';
import { nodes } from './helpers';

const parse = (source: string) => new SNFParser().parse(source);
const selected = (root: Node, type: T) => nodes(root).filter(n => n.type === type);
const feature = (root: Node, raw: string) => nodes(root).find(n => n.raw.trim() === raw)!;

test('four-digit Base36 uses the entire SHA-256 and preserves leading zeroes', () => {
  for (const text of [
    '', 'MINVALUE', 'MAXVALUE', 'DM_OS_LATCH_STATS', '语法🙂', '\u0000\ufffd',
    ...[55, 56, 63, 64, 65, 127, 128, 1000].map(length => 'a'.repeat(length)),
  ]) {
    const digest = createHash('sha256').update(text).digest('hex');
    assert.equal(hash256(text), digest.toUpperCase());
    assert.equal(shortCode(text), (BigInt(`0x${digest}`) % 1679616n).toString(36).toUpperCase().padStart(4, '0'));
  }
  assert.equal(shortCode('MINVALUE'), '882V');
  assert.equal(shortCode('MAXVALUE'), 'UFLF');
  assert.equal(shortCode('DM_OS_LATCH_STATS'), 'TO0Q');
  assert.equal(shortCode('WORD57'), '0HYN');
});

test('QUOTED, OPTIONAL and GROUP share one four-digit content feature protocol', () => {
  for (const [source, type, code, depth] of [
    ['[NO]', T.OPTIONAL, 'OP00', '0001'],
    ['{NO}', T.GROUP, 'GR00', '0002'],
    ["'NO'", T.QUOTED, 'QT00', '0001'],
  ] as const) {
    const ast = parse(source);
    const parent = type === T.GROUP ? selected(ast, T.ENUM)[0] : ast;
    const path = JSON.stringify([
      'UID_V1', parent.uid!.split('-')[2], 'children', code, shortCode(JSON.stringify([['D', 'NO']])),
      type === T.QUOTED ? "'" : null, null, null,
    ]);
    const digest = createHash('sha256').update(path).digest('hex').slice(0, 32).toUpperCase();
    assert.equal(selected(ast, type)[0].uid, `${code}-${depth}-${digest}-0000`);
  }
});

test('GROUP and OPTIONAL survive reordering, insertion, variable renaming and ordinary formatting', () => {
  for (const type of [T.GROUP, T.OPTIONAL]) {
    const source = type === T.GROUP
      ? '{ NO MINVALUE first | NO MAXVALUE second }'
      : '[ NO MINVALUE first ] [ NO MAXVALUE second ]';
    const changed = type === T.GROUP
      ? '{ NO MAXVALUE renamed | NO CYCLE extra | NO\n MINVALUE other }'
      : '[ NO MAXVALUE renamed ] [ NO CYCLE extra ] [ NO\n MINVALUE other ]';
    const before = parse(source), after = parse(changed);
    for (const [oldWord, newWord] of [['first', 'other'], ['second', 'renamed']]) {
      const oldBoundary = selected(before, type).find(n => n.raw.includes(oldWord))!;
      const newBoundary = selected(after, type).find(n => n.raw.includes(newWord))!;
      assert.equal(oldBoundary.uid, newBoundary.uid);
      assert.equal(feature(before, oldWord).uid, feature(after, newWord).uid);
      assert.equal(feature(after, newWord).name, newWord);
    }
    assert.deepEqual(findIdentityCollisions(before), []);
    assert.deepEqual(findIdentityCollisions(after), []);
    assert.equal(new Set(selected(before, type).map(n => n.uid!.slice(0, -5))).size, 2);
    assert.ok(selected(before, type).every(n => n.name === (type === T.OPTIONAL ? 'NO' : undefined)));
  }
});

test('all definitions contribute complete content regardless of their position', () => {
  const before = parse('[ input MATCH FULL ] [ input MATCH PARTIAL ] [ input MATCH SIMPLE ]');
  const after = parse('[ renamed MATCH SIMPLE ] [ renamed MATCH FULL ] [ renamed MATCH PARTIAL ]');
  for (const ending of ['FULL', 'PARTIAL', 'SIMPLE']) {
    const oldNode = selected(before, T.OPTIONAL).find(n => n.raw.includes(ending))!;
    const newNode = selected(after, T.OPTIONAL).find(n => n.raw.includes(ending))!;
    assert.equal(oldNode.uid, newNode.uid);
  }
  assert.deepEqual(findIdentityCollisions(before), []);
});

test('numbers retain full content; nested containers contribute only their type initial', () => {
  const before = parse('{ 10 value | 20 value | MODE { A | B } }');
  const after = parse('{ MODE { C | D } | 20 renamed | 10 other }');
  for (const [a, b] of [['10 value', '10 other'], ['20 value', '20 renamed'], ['MODE { A | B }', 'MODE { C | D }']])
    assert.equal(feature(before, a).uid, feature(after, b).uid);
  assert.notEqual(feature(before, '10 value').uid!.slice(0, -5), feature(before, '20 value').uid!.slice(0, -5));
});

test('quoted literals distinguish branches and preserve each branch UID on reordering', () => {
  for (const alternatives of [
    ["'Y'", "'N'"],
    ['"SYS.DM_OS_LATCH_STATS"', '"SYS.DM_OS_WAIT_STATS"'],
    ["'A B'", "'A  B'"],
    ["'A'", '"A"'],
    ["''", "' '"],
    ["'IT''S'", "'ITS'"],
    ["'A.B'", "'A-B'"],
    ["'A''B'", "'A+B'"],
    ["'+'", "'-'"],
    ["'V'", "'value'"],
    ["'A B'", "'A\tB'"],
    ["'A\r\nB'", "'A\nB'"],
  ]) {
    const before = parse(`{ ${alternatives.join(' | ')} }`);
    const after = parse(`{ ${alternatives.slice().reverse().join(' | ')} }`);
    for (const raw of alternatives) {
      const group = (root: Node) => selected(root, T.GROUP).find(n => n.raw.trim() === raw)!;
      assert.equal(group(before).uid, group(after).uid);
    }
    assert.deepEqual(findIdentityCollisions(before), []);
  }
  assert.equal(selected(parse("[ 'value' ]"), T.OPTIONAL)[0].uid, selected(parse("[ 'renamed' ]"), T.OPTIONAL)[0].uid);
  assert.notEqual(selected(parse("[ 'Y' ]"), T.OPTIONAL)[0].uid, selected(parse("[ 'N' ]"), T.OPTIONAL)[0].uid);
});

test('literal definitions, numbers and type initials have separate feature categories', () => {
  for (const source of ['{ V | value }', '[ V ] [ value ]'])
    assert.deepEqual(findIdentityCollisions(parse(source)), []);
  // A real all-numeric Base36 code must not collide with a NUMBER token.
  assert.equal(shortCode('WORD139'), '9192');
  assert.deepEqual(findIdentityCollisions(parse('{ NO WORD139 | NO 9192 }')), []);
});

test('literal symbols are content-sensitive in inherited quote scopes without changing external symbol rules', () => {
  for (const type of [T.OPTIONAL, T.GROUP]) {
    const before = parse(type === T.OPTIONAL ? "'[ A+B ]'" : "'{ A+B | C }'");
    const after = parse(type === T.OPTIONAL ? "'[ A-B ]'" : "'{ A-B | C }'");
    assert.notEqual(selected(before, type)[0].uid, selected(after, type)[0].uid);
  }
  assert.equal(findIdentityCollisions(parse('{ + | - }'))[0].kind, 'same-signature');
});

test('inherited quoted whitespace participates in OPTIONAL and GROUP identities', () => {
  for (const [before, after] of [["'[ A B ]'", "'[ A  B ]'"], ["'{ A B | C }'", "'{ A  B | C }'"]]) {
    const type = before.includes('[') ? T.OPTIONAL : T.GROUP;
    assert.notEqual(selected(parse(before), type)[0].uid, selected(parse(after), type)[0].uid);
  }
});

test('real four-character collisions are detected on all three boundary types', () => {
  for (const [source, type] of [
    ['{WORD277|WORD1396}', T.GROUP],
    ['[WORD277] [WORD1396]', T.OPTIONAL],
    ['"WORD277" "WORD1396"', T.QUOTED],
  ] as const) {
    const ast = parse(source), before = structuredClone(ast);
    const collisions = findIdentityCollisions(ast);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].kind, 'short-hash');
    assert.equal(new Set(collisions[0].occurrences.map(n => n.fullSignature)).size, 2);
    assert.equal(selected(ast, type).length, 2);
    for (const occurrence of collisions[0].occurrences)
      assert.equal(source.slice(occurrence.start, occurrence.end), occurrence.raw);
    assert.equal(new Set(nodes(ast).map(n => n.uid)).size, nodes(ast).length);
    assert.deepEqual(ast, before);
  }
});

test('a parent reports equal direct features while the child QUOTED identifies the collision cause', () => {
  const collisions = findIdentityCollisions(parse('{"WORD277"|"WORD1396"}'));
  assert.equal(collisions.find(c => c.prefix.startsWith('GR00'))!.kind, 'same-signature');
  const quoted = collisions.find(c => c.prefix.startsWith('QT00'))!;
  assert.equal(quoted.kind, 'short-hash');
  assert.deepEqual(quoted.occurrences.map(n => n.fullSignature), ['[["D","WORD277"]]', '[["D","WORD1396"]]']);
});

test('QUOTED hashes the complete normalized feature sequence to four Base36 digits', () => {
  for (const [literal, value] of [["'Y'", 'Y'], ['"N"', 'N']]) {
    const ast = parse(`[ ${literal} ]`);
    const content = JSON.stringify([['D', value]]);
    const digest = createHash('sha256').update(content).digest('hex');
    const code = (BigInt(`0x${digest}`) % 1679616n).toString(36).toUpperCase().padStart(4, '0');
    const path = JSON.stringify([
      'UID_V1', ast.uid!.split('-')[2], 'children', 'OP00', shortCode(JSON.stringify([['Q', literal[0], code]])), null, null, null,
    ]);
    const expected = createHash('sha256').update(path).digest('hex').slice(0, 32).toUpperCase();
    assert.equal(selected(ast, T.OPTIONAL)[0].uid, `OP00-0001-${expected}-0000`);
  }
  // Individually shortened words collide, but complete feature arrays remain distinct.
  assert.deepEqual(findIdentityCollisions(parse('{ "NO WORD1260" | "NO WORD1300" }')), []);
  assert.equal(shortCode(JSON.stringify([['D', 'WORD277']])), 'UGSZ');
  assert.equal(shortCode(JSON.stringify([['D', 'WORD1396']])), 'UGSZ');
  assert.deepEqual(findIdentityCollisions(parse(`{ 'WORD277' | "WORD1396" }`)), []);
});

test('different parent paths isolate matching local codes', () => {
  for (const source of ['LEFT {WORD277} RIGHT {WORD1396}', '[LEFT \"WORD277\"] [RIGHT \"WORD1396\"]'])
    assert.deepEqual(findIdentityCollisions(parse(source)), []);
});

test('structural ambiguity is reported separately, retaining documented ordinal fallback', () => {
  for (const source of ['{ first | second }', '{ = | := }', '[ { A | B } ] [ { C | D } ]']) {
    const collision = findIdentityCollisions(parse(source))[0];
    assert.equal(collision.kind, 'same-signature');
    assert.deepEqual(collision.occurrences.map(n => n.uid!.slice(-4)), ['0000', '0001']);
  }
  const before = parse('{ WORD277 | WORD1396 }'), after = parse('{ WORD1396 | WORD277 }');
  assert.notEqual(selected(before, T.GROUP)[0].uid, selected(after, T.GROUP)[1].uid);
});

test('collision detection includes all roots in a document session with source locations', () => {
  const document = new SNFDocumentParser().parse('[ WORD277 ]\n\n# WHERE unused\n[ WORD1396 ]');
  const roots = [...document.entries, ...document.definitions].map(n => n.ast);
  const collision = findIdentityCollisions(roots)[0];
  assert.equal(collision.kind, 'short-hash');
  assert.deepEqual(collision.occurrences.map(n => n.sourceBlock), [0, 1]);
  assert.deepEqual(findIdentityCollisions(roots[0]), []);
});

test('definition expansion and loop binding preserve boundary and descendant IDs on renaming and reordering', () => {
  const document = (swapped: boolean) => new SNFDocumentParser().parse(
    `ORDER BY ${swapped ? 'renamed' : 'item'} [, ...]\n\n# WHERE ${swapped ? 'renamed' : 'item'}\n` +
    (swapped ? 'field { DESC | ASC } [ NO MAXVALUE ] [ NO MINVALUE ]' : 'column { ASC | DESC } [ NO MINVALUE ] [ NO MAXVALUE ]'),
  ).entries[0].ast;
  const before = document(false), after = document(true);
  for (const type of [T.LOOP, T.COLLECTION, T.VARIABLE, T.GROUP, T.OPTIONAL])
    assert.deepEqual(selected(before, type).map(n => n.uid).sort(), selected(after, type).map(n => n.uid).sort());
});

test('collision diagnostics reject unassigned boundary identities', () => {
  const ast = parse('[ A ]');
  delete selected(ast, T.OPTIONAL)[0].uid;
  assert.throws(() => findIdentityCollisions(ast), /requires a final AST/);
});

test('collision diagnostics ignore duplicate root objects and reject duplicate UIDs or unassigned roots', () => {
  const ast = parse('{ WORD277 | WORD1396 }');
  assert.deepEqual(findIdentityCollisions([ast, ast]), findIdentityCollisions(ast));
  assert.throws(() => findIdentityCollisions([ast, structuredClone(ast)]), /unique UIDs from one parse session/);
  assert.throws(() => findIdentityCollisions([parse('[ A ]'), parse('[ B ]')]), /unique UIDs from one parse session/);
  const unassigned = parse('A');
  delete unassigned.uid;
  assert.throws(() => findIdentityCollisions(unassigned), /requires a final AST/);
});

test('postorder features ignore input names, UIDs and source metadata', () => {
  const ast = parse(`[ DEFAULT 'value' [ INNER input ] { A | B } ]`);
  const changed = structuredClone(ast);
  for (const node of nodes(changed)) {
    node.uid = 'unused';
    node.name = 'unused';
    node.raw = 'unused';
    node.start = 999;
    if (node.type === T.VARIABLE) node.content = 'renamed';
  }
  const before = structuredClone(changed);
  assert.deepEqual([...collectLocalFeatures([ast]).values()], [...collectLocalFeatures([changed]).values()]);
  assert.deepEqual(changed, before);
  assert.deepEqual(nodes(createIdentityAllocator()(changed)).map(n => n.uid), nodes(ast).map(n => n.uid));
});

test('parents read only direct features; nested ordinary containers do not expose their content', () => {
  for (const [before, after] of [
    ['[ A [ B b ] ]', '[ A [ C c ] ]'],
    ['[ [ A a ] [ B b ] ]', '[ [ B b ] [ A a ] ]'],
    ["'A [ B b ]'", "'A [ C c ]'"],
  ]) {
    const a = parse(before), b = parse(after);
    const boundary = (root: Node) => nodes(root).find(n => [T.OPTIONAL, T.QUOTED].includes(n.type))!;
    assert.equal(boundary(a).uid, boundary(b).uid);
  }
  const a = parse('[ [ A a ] [ B b ] ]'), b = parse('[ [ B b ] [ A a ] ]');
  assert.equal(feature(a, '[ A a ]').uid, feature(b, '[ A a ]').uid);
  assert.equal(feature(a, '[ B b ]').uid, feature(b, '[ B b ]').uid);
  assert.notEqual(selected(parse("[ 'Y' ]"), T.OPTIONAL)[0].uid, selected(parse("[ 'N' ]"), T.OPTIONAL)[0].uid);
});

test('direct-child order remains meaningful, including fixed text moved across an OPTIONAL', () => {
  for (const [before, after, type] of [
    ['[ A [ B b ] ]', '[ [ B b ] A ]', T.OPTIONAL],
    ['{ A B }', '{ B A }', T.GROUP],
    ["'A B'", "'B A'", T.QUOTED],
  ] as const) {
    assert.notEqual(selected(parse(before), type)[0].uid, selected(parse(after), type)[0].uid);
  }
});

test('deep feature preparation and UID assignment are iterative and do not use recursive signatures', () => {
  const root: Node = { type: T.ROOT, content: '', raw: '', start: 0, end: 0 };
  let tail = root;
  for (let depth = 0; depth < 12000; depth++) {
    const child: Node = { type: T.QUOTED, content: '', raw: '', start: 0, end: 0, quote: "'", children: [] };
    tail.children = [child];
    tail = child;
  }
  const features = collectLocalFeatures([root]);
  assert.equal(features.size, 12000);
  assert.equal(features.keys().next().value, tail);
  for (const feature of features.values()) {
    assert.match(feature.code, /^[0-9A-Z]{4}$/);
    assert.ok(feature.signature.length < 30);
  }
  const result = createIdentityAllocator()(root);
  assert.equal(nodes(result).length, 12001);
  assert.equal(findIdentityCollisions(result).length, 0);
});

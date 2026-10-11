import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Node, NodeType as T, SNFParser, SNFDocumentParser, UID_TYPE_CODES, UID_VERSION } from '../src/index';
import { createUidAllocator, createIdentityAllocator } from '../src/internal/identity';
import { hash128 } from '../src/internal/hash';
import { nodes } from './helpers';
const parse = (s: string) => new SNFParser().parse(s);

const vars = (root: Node) => nodes(root).filter(n => n.type === T.VARIABLE);
const ids = (root: Node, type: T) =>
  nodes(root)
    .filter(n => n.type === type)
    .map(n => n.uid);
const named = (root: Node, name: string) => vars(root).find(n => n.content === name)!;
const prefix = (node: Node) => node.uid!.slice(0, -5);
const document = (s: string) => new SNFDocumentParser().parse(s);
const allDoc = (s: string) => [...document(s).entries, ...document(s).definitions].flatMap(b => nodes(b.ast));
const leaf = (type: T, content = ''): Node => ({
  type,
  content,
  raw: content,
  start: 0,
  end: content.length,
});

test('SHA-256 UTF-8 digest matches independent Node crypto vectors', () => {
  for (const input of [
    '',
    'abc',
    '语法🙂',
    '\u0000\ufffd',
    ...[55, 56, 63, 64, 65, 127, 128, 1000].map(n => 'a'.repeat(n)),
  ]) {
    assert.equal(hash128(input), createHash('sha256').update(input).digest('hex').slice(0, 32).toUpperCase());
  }
});
test('version, type registry and serialized root identity are fixed', () => {
  assert.equal(UID_VERSION, 'UID_V1');
  assert.equal(Object.keys(UID_TYPE_CODES).length, Object.values(T).length);
  assert.equal(new Set(Object.values(UID_TYPE_CODES)).size, Object.values(T).length);
  assert.ok(Object.isFrozen(UID_TYPE_CODES));
  const serialized = JSON.stringify(['UID_V1', null, 'root', 'RO00', null, null, null, null]);
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 32).toUpperCase();
  assert.equal(parse('SELECT a').uid, `RO00-0000-${digest}-0000`);
});
test('UID_V1 functional path includes ancestor and separator semantics', () => {
  assert.notDeepEqual(ids(parse('COLUMNS item [, ...]'), T.LOOP), ids(parse('COLUMNS item [; ...]'), T.LOOP));
  assert.equal(
    nodes(parse('COLUMNS item [, ...]')).some(n => n.type === T.REPEAT),
    false,
  );
});
test('independent runs, variable renaming and same-prefix position identity', () => {
  assert.deepEqual(parse('SELECT a, b'), parse('SELECT a, b'));
  assert.deepEqual(ids(parse('SELECT a, b'), T.VARIABLE), ids(parse('SELECT b, a'), T.VARIABLE));
  const before = vars(parse('SELECT a, b')),
    after = vars(parse('SELECT x, a, b'));
  assert.deepEqual(
    before.map(n => n.uid),
    after.slice(0, 2).map(n => n.uid),
  );
  assert.equal(after[2].uid!.slice(-4), '0002');
});
test('formatting, different-prefix insertions and OPTIONAL reordering', () => {
  const a = parse('SELECT a, b [ LIMIT count ] [ OFFSET position ]');
  const b = parse('SELECT\n  x, y [ OFFSET pos ]\n\t[ LIMIT limit ]');
  for (const [from, to] of [
    ['a', 'x'],
    ['b', 'y'],
    ['count', 'limit'],
    ['position', 'pos'],
  ])
    assert.equal(named(a, from).uid, named(b, to).uid);
  assert.deepEqual(ids(a, T.OPTIONAL).sort(), ids(b, T.OPTIONAL).sort());
  const c = parse('SELECT a, b [ FETCH amount ] [ LIMIT count ] [ OFFSET position ]');
  assert.equal(named(a, 'count').uid, named(c, 'count').uid);
});
test('complete variable/enum/loop features follow their DEFINITION context when reordered', () => {
  const a = parse('MODE mode FORMAT { JSON | XML } COLUMNS column [, ...]');
  const b = parse('COLUMNS renamed [, ...] FORMAT { XML | JSON } MODE other');
  assert.equal(named(a, 'mode').uid, named(b, 'other').uid);
  assert.equal(named(a, 'column').uid, named(b, 'renamed').uid);
  for (const type of [T.ENUM, T.LOOP]) assert.deepEqual(ids(a, type), ids(b, type));
});
test('continuous keyword runs distinguish ORDER BY/PARTITION BY across ordinary newlines', () => {
  const a = parse('ORDER BY col PARTITION BY part'),
    b = parse('PARTITION\nBY p ORDER\nBY c');
  assert.equal(named(a, 'col').uid, named(b, 'c').uid);
  assert.equal(named(a, 'part').uid, named(b, 'p').uid);
  assert.notEqual(prefix(named(a, 'col')), prefix(named(a, 'part')));
  assert.notEqual(named(parse('ORDER x BY col'), 'col').uid, named(a, 'col').uid);
  assert.notEqual(named(parse('ORDER , BY col'), 'col').uid, named(a, 'col').uid);
});
test('child scopes inherit but do not concatenate or leak keyword runs', () => {
  const a = parse('OUTER [ INNER inside ] tail'),
    b = parse('OTHER [ INNER inside ] tail');
  assert.equal(named(a, 'inside').uid, named(b, 'inside').uid);
  assert.notEqual(named(a, 'tail').uid, named(b, 'tail').uid);
  assert.equal(
    named(parse('USING { BTREE | HASH } item'), 'item').uid,
    named(parse('USING { HASH | BTREE } item'), 'item').uid,
  );
  assert.equal(
    named(parse('FIRST [ INNER val ] SECOND tail'), 'tail').uid,
    named(parse('SECOND tail'), 'tail').uid,
  );
});
test('sibling GROUP scopes isolate keywords and ignore ancestor ordinals', () => {
  const a = parse('MODE { LIMIT a | OFFSET b }'),
    b = parse('MODE { OFFSET y | LIMIT x }');
  assert.equal(named(a, 'a').uid, named(b, 'x').uid);
  assert.equal(named(a, 'b').uid, named(b, 'y').uid);
  assert.equal(named(parse('MODE { INNER a | b }'), 'b').uid, named(parse('MODE { b | INNER a }'), 'b').uid);
  const c = parse('MODE { LIMIT first | OFFSET second | FETCH third }');
  assert.equal(named(a, 'b').uid, named(c, 'second').uid);
});
test('OPTIONAL signatures include direct children but do not expand nested enum contents', () => {
  assert.deepEqual(ids(parse('[ { A | B } ]'), T.OPTIONAL), ids(parse('[ { C | D } ]'), T.OPTIONAL));
  assert.deepEqual(
    ids(parse('[ value = other ]'), T.OPTIONAL),
    ids(parse('[ renamed = second ]'), T.OPTIONAL),
  );
  assert.notDeepEqual(ids(parse('[ 10 value ]'), T.OPTIONAL), ids(parse('[ 20 value ]'), T.OPTIONAL));
  assert.notEqual(named(parse('[ LIMIT x ]'), 'x').uid, named(parse('[ OFFSET x ]'), 'x').uid);
});
test('real wrappers, fixed context and quote semantics may change identity', () => {
  assert.notEqual(named(parse('SELECT x'), 'x').uid, named(parse('SELECT [ x ]'), 'x').uid);
  assert.notEqual(named(parse('SELECT x'), 'x').uid, named(parse('FROM x'), 'x').uid);
  assert.notEqual(named(parse("SELECT 'x'"), 'x').uid, named(parse('SELECT "x"'), 'x').uid);
  assert.notEqual(named(parse("SELECT 'x'"), 'x').uid, named(parse('SELECT x'), 'x').uid);
  assert.notDeepEqual(ids(parse("'A B'"), T.BLANK), ids(parse("'A  B'"), T.BLANK));
  assert.equal(named(parse("DEFAULT 'FIXED' x"), 'x').uid, named(parse("DEFAULT 'OTHER' x"), 'x').uid);
  assert.equal(
    named(createIdentityAllocator()(parse("DEFAULT 'FIXED' x")), 'x').uid,
    named(createIdentityAllocator()(parse("DEFAULT 'OTHER' x")), 'x').uid,
  );
});
test('decoded fixed tokens, not raw escape spelling, define identity', () => {
  assert.equal(named(parse('SELECT x'), 'x').uid, named(parse(String.raw`\SELECT x`), 'x').uid);
  assert.deepEqual(ids(parse('[ = value ]'), T.OPTIONAL), ids(parse(String.raw`[ \= value ]`), T.OPTIONAL));
});
test('document sessions reset counts; entries reset contexts but share uniqueness counters', () => {
  const source = '# CASE A\nSELECT a\n\n# WHERE helper\nb';
  assert.deepEqual(document(source), document(source));
  assert.deepEqual(
    allDoc(source).map(n => n.uid),
    allDoc(source.replace('# CASE A', '# CASE RENAMED')).map(n => n.uid),
  );
  const a = allDoc(source).find(n => n.content === 'b' && n.type === T.VARIABLE)!;
  assert.equal(a.uid, named(parse('b'), 'b').uid);
  const repeated = allDoc('SELECT a\n\nSELECT a');
  assert.equal(new Set(repeated.map(n => n.uid)).size, repeated.length);
  const vals = repeated.filter(n => n.type === T.VARIABLE);
  assert.equal(prefix(vals[0]), prefix(vals[1]));
  assert.equal(vals[1].uid!.slice(-4), '0001');
});
test('IDs overwrite previous results without mutating nodes, children ', () => {
  const input = parse('COLUMNS item [, ...]');
  for (const n of nodes(input)) {
    n.uid = 'obsolete';
    n.name = 'ignored';
  }
  const before = JSON.stringify(input);
  const out = createIdentityAllocator()(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(nodes(out).every(n => n.uid !== 'obsolete'));
  assert.deepEqual(
    nodes(out).map(n => n.uid),
    nodes(parse('COLUMNS item [, ...]')).map(n => n.uid),
  );
  assert.ok(nodes(out).every(n => !nodes(input).includes(n)));
});
test('hash collision fails explicitly and rolls back the allocator', () => {
  let collide = true;
  const allocator = createUidAllocator(input => (collide ? '0'.repeat(32) : hash128(input)));
  assert.throws(() => allocator(parse('SELECT x')), /hash collision/);
  collide = false;
  assert.deepEqual(allocator(parse('SELECT x')), createIdentityAllocator()(parse('SELECT x')));
});
test('unknown node types cannot inherit registry properties or consume IDs', () => {
  const allocate = createIdentityAllocator();
  for (const type of ['toString', '__proto__', 'unknown']) {
    const invalid = { ...leaf(T.ROOT), children: [leaf(T.VARIABLE, 'x'), leaf(type as T)] };
    assert.throws(() => allocate(invalid), /Unknown SNF uid node type/);
  }
  assert.deepEqual(allocate(parse('SELECT x')), createIdentityAllocator()(parse('SELECT x')));
});
test('ordinal FFFF is valid, 10000 fails without wrapping or consuming state', () => {
  const root = { ...leaf(T.ROOT), children: Array.from({ length: 65536 }, () => leaf(T.VARIABLE, 'x')) };
  const out = createIdentityAllocator()(root);
  assert.equal(out.children!.at(-1)!.uid!.slice(-4), 'FFFF');
  const allocate = createIdentityAllocator();
  assert.throws(
    () => allocate({ ...root, children: [...root.children, leaf(T.VARIABLE, 'x')] }),
    /ordinal overflow/,
  );
  assert.equal(allocate(leaf(T.VARIABLE, 'x')).uid!.slice(-4), '0000');
});
test('depth FFFF is valid and 10000 raises a deliberate error instead of stack overflow', () => {
  const root = leaf(T.ROOT);
  let tail = root;
  for (let i = 0; i < 65535; i++) {
    const child = leaf(T.COLLECTION);
    tail.children = [child];
    tail = child;
  }
  const out = createIdentityAllocator()(root);
  let last = out;
  while (last.children?.length) last = last.children[0];
  assert.equal(last.uid!.split('-')[1], 'FFFF');
  tail.children = [leaf(T.VARIABLE, 'x')];
  assert.throws(() => createIdentityAllocator()(root), /uid depth overflow/);
});

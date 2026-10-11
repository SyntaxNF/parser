import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  Node, NodeType as T, SNFParser, SNFDocumentParser,
  createAddUid, addDocumentUid, UID_TYPE_CODES, UID_VERSION,
  exchangeLoopNode, exchangeQuoteNode, walkDocument,
} from '../src/index';
import { createUidAllocator } from '../src/walkers/uid';
import { hash128 } from '../src/walkers/uid-hash';
const parse = (s: string) => new SNFParser().parse(s);
const logical = (s: string) => exchangeLoopNode(exchangeQuoteNode(parse(s)));
const uid = (s: string) => createAddUid()(logical(s));
const nodes = (root: Node): Node[] => {
  const result: Node[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    if (node.ast) pending.push(...(Array.isArray(node.ast) ? [...node.ast].reverse() : [node.ast]));
    pending.push(...(node.children ?? []).slice().reverse());
  }
  return result;
};
const vars = (root: Node) => nodes(root).filter(n => n.type === T.VARIABLE);
const ids = (root: Node, type: T) => nodes(root).filter(n => n.type === type).map(n => n.uid);
const named = (root: Node, name: string) => vars(root).find(n => n.content === name)!;
const prefix = (node: Node) => node.uid!.slice(0, -5);
const document = (s: string) => addDocumentUid(walkDocument(new SNFDocumentParser().parse(s), exchangeQuoteNode, exchangeLoopNode));
const allDoc = (s: string) => document(s).blocks.flatMap(b => nodes(b.ast));
const leaf = (type: T, content = ''): Node => ({ type, content, raw: content, start: 0, end: content.length });

test('SHA-256 UTF-8 digest matches independent Node crypto vectors', () => {
  for (const input of ['', 'abc', '语法🙂', '\u0000\ufffd', ...[55, 56, 63, 64, 65, 127, 128, 1000].map(n => 'a'.repeat(n))]) {
    assert.equal(hash128(input), createHash('sha256').update(input).digest('hex').slice(0, 32).toUpperCase());
  }
});
test('version, type registry and serialized root identity are fixed', () => {
  assert.equal(UID_VERSION, 'snf-uid-v1');
  assert.equal(Object.keys(UID_TYPE_CODES).length, Object.values(T).length);
  assert.equal(new Set(Object.values(UID_TYPE_CODES)).size, Object.values(T).length);
  assert.ok(Object.isFrozen(UID_TYPE_CODES));
  const serialized = JSON.stringify(['snf-uid-v1', null, 'root', 'RO00', null, null]);
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 32).toUpperCase();
  assert.equal(uid('SELECT a').uid, `RO00-0000-${digest}-0000`);
});
test('v1 path encoding is pinned independently through ancestors and auxiliary edges', () => {
  const digest = (parent: string | null, edge: string, type: string, local: unknown) => createHash('sha256')
    .update(JSON.stringify(['snf-uid-v1', parent, edge, type, local, null])).digest('hex').slice(0, 32).toUpperCase();
  const root = digest(null, 'root', 'RO00', null);
  const optional = digest(root, 'children', 'OP00', ['DE00', 'LIMIT']);
  const variable = digest(optional, 'children', 'VA00', ['DEFINITION_CONTEXT', ['LIMIT']]);
  assert.equal(named(uid('SELECT [ LIMIT value ]'), 'value').uid, `VA00-0002-${variable}-0000`);
  const loopHash = digest(root, 'children', 'LO00', ['DEFINITION_CONTEXT', ['COLUMNS']]);
  const repeatHash = digest(loopHash, 'ast', 'RE00', ['RE00', '...']);
  assert.deepEqual(ids(uid('COLUMNS item [, ...]'), T.REPEAT), [`RE00-0002-${repeatHash}-0000`]);
});
test('independent runs, variable renaming and same-prefix position identity', () => {
  assert.deepEqual(uid('SELECT a, b'), uid('SELECT a, b'));
  assert.deepEqual(ids(uid('SELECT a, b'), T.VARIABLE), ids(uid('SELECT b, a'), T.VARIABLE));
  const before = vars(uid('SELECT a, b')), after = vars(uid('SELECT x, a, b'));
  assert.deepEqual(before.map(n => n.uid), after.slice(0, 2).map(n => n.uid));
  assert.equal(after[2].uid!.slice(-4), '0002');
});
test('formatting, different-prefix insertions and OPTIONAL reordering', () => {
  const a = uid('SELECT a, b [ LIMIT count ] [ OFFSET position ]');
  const b = uid('SELECT\n  x, y [ OFFSET pos ]\n\t[ LIMIT limit ]');
  for (const [from, to] of [['a', 'x'], ['b', 'y'], ['count', 'limit'], ['position', 'pos']]) assert.equal(named(a, from).uid, named(b, to).uid);
  assert.deepEqual(ids(a, T.OPTIONAL).sort(), ids(b, T.OPTIONAL).sort());
  const c = uid('SELECT a, b [ FETCH amount ] [ LIMIT count ] [ OFFSET position ]');
  assert.equal(named(a, 'count').uid, named(c, 'count').uid);
});
test('complete variable/enum/loop features follow their DEFINITION context when reordered', () => {
  const a = uid('MODE mode FORMAT { JSON | XML } COLUMNS column [, ...]');
  const b = uid('COLUMNS renamed [, ...] FORMAT { XML | JSON } MODE other');
  assert.equal(named(a, 'mode').uid, named(b, 'other').uid);
  assert.equal(named(a, 'column').uid, named(b, 'renamed').uid);
  for (const type of [T.ENUM, T.LOOP]) assert.deepEqual(ids(a, type), ids(b, type));
});
test('continuous keyword runs distinguish ORDER BY/PARTITION BY across ordinary newlines', () => {
  const a = uid('ORDER BY col PARTITION BY part'), b = uid('PARTITION\nBY p ORDER\nBY c');
  assert.equal(named(a, 'col').uid, named(b, 'c').uid);
  assert.equal(named(a, 'part').uid, named(b, 'p').uid);
  assert.notEqual(prefix(named(a, 'col')), prefix(named(a, 'part')));
  assert.notEqual(named(uid('ORDER x BY col'), 'col').uid, named(a, 'col').uid);
  assert.notEqual(named(uid('ORDER , BY col'), 'col').uid, named(a, 'col').uid);
});
test('child scopes inherit but do not concatenate or leak keyword runs', () => {
  const a = uid('OUTER [ INNER inside ] tail'), b = uid('OTHER [ INNER inside ] tail');
  assert.equal(named(a, 'inside').uid, named(b, 'inside').uid);
  assert.notEqual(named(a, 'tail').uid, named(b, 'tail').uid);
  assert.equal(named(uid('USING { BTREE | HASH } item'), 'item').uid, named(uid('USING { HASH | BTREE } item'), 'item').uid);
  assert.equal(named(uid('FIRST [ INNER val ] SECOND tail'), 'tail').uid, named(uid('SECOND tail'), 'tail').uid);
});
test('sibling GROUP scopes isolate keywords and ignore ancestor ordinals', () => {
  const a = uid('MODE { LIMIT a | OFFSET b }'), b = uid('MODE { OFFSET y | LIMIT x }');
  assert.equal(named(a, 'a').uid, named(b, 'x').uid);
  assert.equal(named(a, 'b').uid, named(b, 'y').uid);
  assert.equal(named(uid('MODE { INNER a | b }'), 'b').uid, named(uid('MODE { b | INNER a }'), 'b').uid);
  const c = uid('MODE { LIMIT first | OFFSET second | FETCH third }');
  assert.equal(named(a, 'b').uid, named(c, 'second').uid);
});
test('OPTIONAL scans only direct fixed children and ignores nested content', () => {
  assert.deepEqual(ids(uid('[ { A | B } ]'), T.OPTIONAL), ids(uid('[ { C | D } ]'), T.OPTIONAL));
  assert.deepEqual(ids(uid('[ value = other ]'), T.OPTIONAL), ids(uid('[ renamed = second ]'), T.OPTIONAL));
  assert.notDeepEqual(ids(uid('[ 10 value ]'), T.OPTIONAL), ids(uid('[ 20 value ]'), T.OPTIONAL));
  assert.notEqual(named(uid('[ LIMIT x ]'), 'x').uid, named(uid('[ OFFSET x ]'), 'x').uid);
});
test('real wrappers, fixed context and quote semantics may change identity', () => {
  assert.notEqual(named(uid('SELECT x'), 'x').uid, named(uid('SELECT [ x ]'), 'x').uid);
  assert.notEqual(named(uid('SELECT x'), 'x').uid, named(uid('FROM x'), 'x').uid);
  assert.notEqual(named(uid("SELECT 'x'"), 'x').uid, named(uid('SELECT "x"'), 'x').uid);
  assert.notEqual(named(uid("SELECT 'x'"), 'x').uid, named(uid('SELECT x'), 'x').uid);
  assert.notDeepEqual(ids(uid("'A B'"), T.BLANK), ids(uid("'A  B'"), T.BLANK));
  assert.equal(named(uid("DEFAULT 'FIXED' x"), 'x').uid, named(uid("DEFAULT 'OTHER' x"), 'x').uid);
  assert.equal(named(createAddUid()(parse("DEFAULT 'FIXED' x")), 'x').uid, named(createAddUid()(parse("DEFAULT 'OTHER' x")), 'x').uid);
});
test('decoded fixed tokens, not raw escape spelling, define identity', () => {
  assert.equal(named(uid('SELECT x'), 'x').uid, named(uid(String.raw`\SELECT x`), 'x').uid);
  assert.deepEqual(ids(uid('[ = value ]'), T.OPTIONAL), ids(uid(String.raw`[ \= value ]`), T.OPTIONAL));
});
test('document sessions reset counts; Blocks reset contexts but share uniqueness counters', () => {
  const source = '# CASE A\nSELECT a\n\n# WHERE b\nb';
  assert.deepEqual(document(source), document(source));
  assert.deepEqual(allDoc(source).map(n => n.uid), allDoc(source.replace('# CASE A', '# CASE RENAMED')).map(n => n.uid));
  const a = allDoc(source).find(n => n.content === 'b' && n.type === T.VARIABLE)!;
  assert.equal(a.uid, named(uid('b'), 'b').uid);
  const repeated = allDoc('SELECT a\n\nSELECT a');
  assert.equal(new Set(repeated.map(n => n.uid)).size, repeated.length);
  const vals = repeated.filter(n => n.type === T.VARIABLE);
  assert.equal(prefix(vals[0]), prefix(vals[1]));
  assert.equal(vals[1].uid!.slice(-4), '0001');
});
test('IDs overwrite previous results without mutating nodes, children or auxiliary trees', () => {
  const input = logical('COLUMNS item [, ...]');
  for (const n of nodes(input)) { n.uid = 'obsolete'; n.name = 'ignored'; }
  const before = JSON.stringify(input);
  const out = createAddUid()(input);
  assert.equal(JSON.stringify(input), before);
  assert.ok(nodes(out).every(n => n.uid !== 'obsolete'));
  assert.deepEqual(nodes(out).map(n => n.uid), nodes(uid('COLUMNS item [, ...]')).map(n => n.uid));
  assert.ok(nodes(out).every(n => !nodes(input).includes(n)));
});
test('children and ast edges have independent context, unique IDs and scalar/array shapes', () => {
  const child = leaf(T.VARIABLE, 'v');
  const root = { ...leaf(T.ROOT), children: [leaf(T.DEFINITION, 'OUTER'), { ...leaf(T.COLLECTION), children: [leaf(T.DEFINITION, 'INNER'), child], ast: child }] };
  const out = createAddUid()(root), collection = out.children![1];
  assert.ok(!Array.isArray(collection.ast));
  const auxiliary = collection.ast as Node;
  assert.notEqual(auxiliary.uid, collection.children![1].uid);
  const changed = { ...root, children: [root.children[0], { ...root.children[1], children: [leaf(T.DEFINITION, 'CHANGED'), child] }] };
  assert.equal((createAddUid()(changed).children![1].ast as Node).uid, auxiliary.uid);
  const loop = nodes(uid('COLUMNS v [, ...]')).find(n => n.type === T.LOOP)!;
  assert.ok(Array.isArray(loop.ast));
  assert.ok((loop.ast as Node[]).every(n => n.uid));
});
test('hash collision fails explicitly and rolls back the allocator', () => {
  let collide = true;
  const allocator = createUidAllocator(input => collide ? '0'.repeat(32) : hash128(input));
  assert.throws(() => allocator(parse('SELECT x')), /hash collision/);
  collide = false;
  assert.deepEqual(allocator(parse('SELECT x')), createAddUid()(parse('SELECT x')));
});
test('unknown node types cannot inherit registry properties or consume IDs', () => {
  const allocate = createAddUid();
  for (const type of ['toString', '__proto__', 'unknown']) {
    const invalid = { ...leaf(T.ROOT), children: [leaf(T.VARIABLE, 'x'), leaf(type as T)] };
    assert.throws(() => allocate(invalid), /Unknown SNF uid node type/);
  }
  assert.deepEqual(allocate(parse('SELECT x')), createAddUid()(parse('SELECT x')));
});
test('ordinal FFFF is valid, 10000 fails without wrapping or consuming state', () => {
  const root = { ...leaf(T.ROOT), children: Array.from({ length: 65536 }, () => leaf(T.VARIABLE, 'x')) };
  const out = createAddUid()(root);
  assert.equal(out.children!.at(-1)!.uid!.slice(-4), 'FFFF');
  const allocate = createAddUid();
  assert.throws(() => allocate({ ...root, children: [...root.children, leaf(T.VARIABLE, 'x')] }), /ordinal overflow/);
  assert.equal(allocate(leaf(T.VARIABLE, 'x')).uid!.slice(-4), '0000');
});
test('depth FFFF is valid and 10000 raises a deliberate error instead of stack overflow', () => {
  const root = leaf(T.ROOT); let tail = root;
  for (let i = 0; i < 65535; i++) { const child = leaf(T.COLLECTION); tail.children = [child]; tail = child; }
  const out = createAddUid()(root); let last = out;
  while (last.children?.length) last = last.children[0];
  assert.equal(last.uid!.split('-')[1], 'FFFF');
  tail.children = [leaf(T.VARIABLE, 'x')];
  assert.throws(() => createAddUid()(root), /uid depth overflow/);
});
test('document walkers use one stable ID session across Blocks', () => {
  const parsed = new SNFDocumentParser().parse('SELECT x\n\nSELECT y');
  const { blocks } = walkDocument(parsed, createAddUid());
  assert.equal(new Set(blocks.flatMap(b => nodes(b.ast)).map(n => n.uid)).size, blocks.flatMap(b => nodes(b.ast)).length);
});

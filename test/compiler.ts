import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../src/index';
import { nodes } from './helpers';
const { SNFDocumentParser, NodeType: T } = api;
const parse = (s: string) => new SNFDocumentParser().parse(s);
test('public API consists only of parsers, diagnostics, types and UID format', () => {
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'DocumentLineType',
      'NodeType',
      'SNFDocumentParser',
      'SNFParseError',
      'SNFParser',
      'UID_TYPE_CODES',
      'UID_VERSION',
      'findIdentityCollisions',
    ].sort(),
  );
});
test('forward WHERE aliases expand transitively, inputs stay leaves', () => {
  const doc = parse(
    'SELECT pair [, ...]\n\n# WHERE pair, pair_alias\ncolumn = value\n\n# WHERE value\n[ DEFAULT fallback ]',
  );
  const n = nodes(doc.entries[0].ast);
  assert.deepEqual(
    n.filter(n => n.type === T.VARIABLE).map(n => n.content),
    ['column', 'fallback'],
  );
  const loop = n.find(n => n.type === T.LOOP)!;
  assert.equal(loop.separator, ',');
  assert.equal(loop.children![0].type, T.COLLECTION);
  assert.equal(loop.children![0].binding?.name, 'pair');
  assert.ok(n.every(n => n.uid));
  assert.ok(doc.blocks.every(b => !Object.hasOwn(b, 'ast')));
});
test('ONEOFIS lines and PARTOFIS blocks become enum alternatives', () => {
  for (const [kind, body] of [
    ['ONEOFIS', 'A\nB value'],
    ['PARTOFIS', 'A\n\nB value'],
  ]) {
    const doc = parse(`MODE choice\n\n# ${kind} choice\n${body}`);
    const choice = nodes(doc.entries[0].ast).find(n => n.type === T.ENUM)!;
    assert.equal(choice.children!.length, 2);
    assert.ok(choice.synthetic);
  }
});
test('recursive definitions are a finite resolved graph with alias targets', () => {
  const doc = parse('SELECT expr_alias\n\n# PARTOFIS expr, expr_alias\nvalue\n\n( expr )');
  const definition = doc.definitions[0];
  assert.ok(definition.recursive);
  const refs = [...doc.entries, ...doc.definitions]
    .flatMap(x => nodes(x.ast))
    .filter(n => n.type === T.REFERENCE);
  assert.equal(refs.length, 2);
  assert.ok(refs.every(n => n.target === definition.ast.uid));
  assert.ok(JSON.stringify(doc));
  const mutual = parse('SELECT left\n\n# WHERE left\nRIGHT right\n\n# WHERE right\nLEFT left');
  assert.ok(mutual.definitions.every(d => d.recursive));
});
test('STATEMENT remains an opaque marker, including declarations without categories', () => {
  for (const body of ['', 'SELECT\nCREATE TABLE', 'SQL\nCOMPOUND', '[opaque | content]']) {
    const doc = parse(`EXECUTE body\n\n# STATEMENT body\n${body}`);
    const statement = nodes(doc.entries[0].ast).find(n => n.type === T.STATEMENT)!;
    assert.equal(statement.name, 'body');
    assert.deepEqual(statement.categories, body ? body.split('\n') : []);
    assert.equal(statement.children, undefined);
  }
});
test('helper renaming and declaration order leave final entry IDs unchanged', () => {
  const a = 'SELECT item [ LIMIT amount ]\n\n# WHERE item\ncolumn [, ...]\n\n# WHERE amount\ncount';
  const b = 'SELECT renamed [ LIMIT size ]\n\n# WHERE size\ncount\n\n# WHERE renamed\ncolumn [, ...]';
  assert.deepEqual(
    nodes(parse(a).entries[0].ast).map(n => n.uid),
    nodes(parse(b).entries[0].ast).map(n => n.uid),
  );
});
test('expanded occurrences have independent identity and source provenance', () => {
  const doc = parse('SELECT item FROM item\n\n# WHERE item\nvalue');
  const n = nodes(doc.entries[0].ast);
  assert.equal(new Set(n.map(n => n.uid)).size, n.length);
  for (const node of n)
    if (!node.synthetic)
      assert.equal(doc.blocks[node.sourceBlock!].content.slice(node.start, node.end), node.raw);
  const inputs = n.filter(n => n.type === T.VARIABLE);
  assert.notEqual(inputs[0], inputs[1]);
  assert.notEqual(inputs[0].uid, inputs[1].uid);
});
test('diagnostics refer to physical document positions', () => {
  assert.throws(
    () => parse('# comment\r\n\r\n# ONEOFIS item\r\nOK\r\n[ A | B ]'),
    (e: unknown) => e instanceof api.SNFParseError && e.line === 5 && e.column === 5,
  );
  for (const s of [
    '# WHERE item\nA\n\n# WHERE item\nB',
    '# CASE A\nA\n\n# CASE A\nB',
    '# WHERE item',
    '# CASE A\nA\n\nB',
  ])
    assert.throws(() => parse(s), api.SNFParseError);
});

test('expanded helper calls retain their functional identity when reordered or inserted', () => {
  const definition = '\n\n# WHERE item, renamed\nVALUE x MODE { A | B } COLUMNS y [, ...]';
  const metadata = (source: string) => {
    const result: Record<string, unknown> = {};
    let context = '';
    for (const node of parse(source + definition).entries[0].ast.children!) {
      if (node.type === T.DEFINITION) context = node.content;
      if (node.type === T.COLLECTION) result[context] = nodes(node).map(n => [n.type, n.uid, n.name]);
    }
    return result;
  };
  const before = metadata('SELECT item FROM item');
  const after = metadata('WHERE item FROM renamed SELECT renamed');
  assert.deepEqual(after.SELECT, before.SELECT);
  assert.deepEqual(after.FROM, before.FROM);
  assert.notDeepEqual(before.SELECT, before.FROM);
});

test('large recursive components compile without overflowing the JavaScript stack', () => {
  const size = 5000;
  const source =
    'SELECT h0\n\n' +
    Array.from({ length: size }, (_, index) => `# WHERE h${index}\nh${(index + 1) % size}`).join('\n\n');
  const doc = parse(source);
  const targets = new Map(doc.definitions.map(d => [d.names[0], d.ast.uid]));
  assert.equal(doc.definitions.length, size);
  assert.ok(doc.definitions.every(d => d.recursive));
  for (const item of [...doc.entries, ...doc.definitions]) {
    for (const node of nodes(item.ast)) {
      if (node.type === T.REFERENCE) assert.equal(node.target, targets.get(node.binding!.name));
    }
  }
});

test('recursive flags and targets match independent graph reachability', () => {
  let seed = 431;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 25; sample++) {
    const graph = Array.from({ length: 8 }, () => Array.from({ length: random() % 3 }, () => random() % 8));
    const source =
      'SELECT h0\n\n' +
      graph
        .map(
          (edges, index) =>
            `# WHERE h${index}, alias${index}\n${edges.length ? edges.map(target => `alias${target}`).join(' ') : 'value'}`,
        )
        .join('\n\n');
    const doc = parse(source);
    const targets = new Map(doc.definitions.flatMap(d => d.names.map(name => [name, d.ast.uid])));
    for (const [index, definition] of doc.definitions.entries()) {
      const seen = new Set<number>(),
        pending = [...graph[index]];
      while (pending.length) {
        const target = pending.pop()!;
        if (seen.has(target)) continue;
        seen.add(target);
        pending.push(...graph[target]);
      }
      assert.equal(definition.recursive, seen.has(index));
    }
    for (const item of [...doc.entries, ...doc.definitions])
      for (const node of nodes(item.ast)) {
        if (node.type === T.REFERENCE) assert.equal(node.target, targets.get(node.binding!.name));
        if (node.type === T.VARIABLE) assert.equal(targets.has(node.content), false);
      }
  }
});

test('deep acyclic expansion reaches the explicit node budget rather than a call-stack failure', () => {
  const size = 5000;
  const source =
    'SELECT h0\n\n' +
    Array.from(
      { length: size },
      (_, index) => `# WHERE h${index}\n${index === size - 1 ? 'value' : `h${index + 1}`}`,
    ).join('\n\n');
  assert.throws(() => parse(source), /Compiled template exceeds 1000000 nodes/);
});

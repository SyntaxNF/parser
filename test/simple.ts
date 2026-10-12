import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Node, NodeType as T, ParseOptions, SimpleNode, SNFDocumentParser, SNFParseError, SNFParser } from '../src/index';
import { simpleNode } from '../src/internal/simple';

const sourceFields = ['raw', 'start', 'end', 'sourceBlock', 'synthetic'];
function nodes(root: Node | SimpleNode): (Node | SimpleNode)[] {
  const result: (Node | SimpleNode)[] = [], pending: (Node | SimpleNode)[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) pending.push(node.children![index]);
  }
  return result;
}

test('default and explicit full mode retain all source payload and metadata', () => {
  const source = '# CASE A\r\nSELECT value\r\n';
  const document = new SNFDocumentParser();
  assert.deepEqual(document.parse(source), document.parse(source, { simple: false }));
  assert.equal(document.parse(source).content, source);
  const parser = new SNFParser();
  const ast = parser.parse('SELECT value');
  assert.deepEqual(ast, parser.parse('SELECT value', { simple: false }));
  assert.equal(ast.raw, 'SELECT value');
  assert.equal(ast.children![0].start, 0);
});

test('simple fragments retain runtime structure and decoded leaf text without source fields', () => {
  const parser = new SNFParser();
  const source = `SELECT 'A  B' [ LIMIT count ] item [, ...]`;
  const full = parser.parse(source), simple = parser.parse(source, { simple: true });
  const original = nodes(full), compact = nodes(simple);
  assert.equal(compact.length, original.length);
  assert.deepEqual(compact.map(node => node.uid), original.map(node => node.uid));
  assert.deepEqual(compact.map(node => node.name), original.map(node => node.name));
  for (const [index, node] of compact.entries()) {
    for (const field of sourceFields) assert.equal(Object.hasOwn(node, field), false);
    assert.equal(node.indentLevel, original[index].indentLevel);
    if (node.children) assert.equal(Object.hasOwn(node, 'content'), false);
    else assert.equal(node.content, original[index].content);
  }
  assert.equal(compact.find(node => node.type === T.QUOTED)!.quote, "'");
  assert.equal(compact.find(node => node.type === T.LOOP)!.separator, ',');
  assert.ok(compact.some(node => node.type === T.BLANK && node.content === '  '));
  const escaped = nodes(parser.parse(String.raw`\[DEFAULT\]`, { simple: true }));
  assert.equal(escaped.filter(node => !node.children).map(node => node.content).join(''), '[DEFAULT]');
  assert.deepEqual(JSON.parse(JSON.stringify(simple)), simple);
});

test('simple documents retain input bindings, STATEMENT categories and resolved recursive targets', () => {
  const source = '# CASE A\nSELECT item body expr_alias\n\n# WHERE item\ncolumn [, ...]\n\n# STATEMENT body\nSQL\nCOMPOUND\n\n# PARTOFIS expr, expr_alias\nvalue\n\n( expr )';
  const parser = new SNFDocumentParser();
  const full = parser.parse(source), simple = parser.parse(source, { simple: true });
  assert.deepEqual(Object.keys(simple).sort(), ['definitions', 'entries', 'type']);
  assert.equal(simple.entries[0].name, 'A');
  assert.deepEqual(simple.entries[0].dependencies, full.entries[0].dependencies);
  for (const item of [...simple.entries, ...simple.definitions]) assert.equal(Object.hasOwn(item, 'blocks'), false);
  const roots = [...simple.entries, ...simple.definitions].map(item => item.ast);
  const all = roots.flatMap(nodes);
  const fullNodes = [...full.entries, ...full.definitions].flatMap(item => nodes(item.ast));
  assert.deepEqual(all.map(node => node.uid), fullNodes.map(node => node.uid));
  for (const node of all) for (const field of sourceFields) assert.equal(Object.hasOwn(node, field), false);
  const collection = all.find(node => node.type === T.COLLECTION)!;
  assert.equal(collection.content, 'item');
  assert.deepEqual(collection.binding, { name: 'item', kind: 'WHERE' });
  const statement = all.find(node => node.type === T.STATEMENT)!;
  assert.equal(statement.content, 'body');
  assert.deepEqual(statement.categories, ['SQL', 'COMPOUND']);
  const targets = new Set(simple.definitions.map(definition => definition.ast.uid));
  const references = all.filter(node => node.type === T.REFERENCE);
  assert.ok(references.length >= 2);
  assert.ok(references.every(node => targets.has(node.target)));
  assert.deepEqual(simple.definitions.find(definition => definition.recursive)!.names, ['expr', 'expr_alias']);
  // Runtime traversal resolves the reference without source blocks or a template lookup.
  const reference = references[0];
  const definition = simple.definitions.find(item => item.ast.uid === reference.target)!;
  const firstGroup = definition.ast.children![0].children![0];
  assert.equal(nodes(firstGroup).find(node => node.type === T.VARIABLE)!.content, 'value');
  assert.deepEqual(JSON.parse(JSON.stringify(simple)).entries[0].ast.uid, full.entries[0].ast.uid);
});

test('a runtime renderer uses simple nodes without template snippets or source positions', () => {
  const source = 'BEGIN\n    item [...]\nEND\n\n# WHERE item\nVALUE x [ { ASC | DESC } ]';
  const doc = new SNFDocumentParser().parse(source, { simple: true });
  const render = (node: SimpleNode): string => {
    if (node.type === T.ENUM) return render(node.children![0]);
    if (node.type === T.LOOP) return [render(node.children![0]), render(node.children![0])].join(node.separator || ' ');
    if (node.type === T.QUOTED) return node.quote! + node.children!.map(render).join('') + node.quote!;
    return node.children ? node.children.map(render).join('') : node.content ?? '';
  };
  assert.equal(render(doc.entries[0].ast).replace(/\s+/g, ' ').trim(), 'BEGIN VALUE x ASC VALUE x ASC END');
});

test('mode switching, dynamic options and failures do not leak into subsequent parse sessions', () => {
  const parser = new SNFDocumentParser();
  const source = '# CASE A\nSELECT value';
  const full = parser.parse(source);
  const options: ParseOptions = { simple: true };
  const simple = parser.parse(source, options);
  assert.equal(Object.hasOwn(simple, 'blocks'), false);
  assert.throws(() => parser.parse('# CASE A\n[ A | B ]', options), (error: unknown) =>
    error instanceof SNFParseError && error.line === 2 && error.column === 5,
  );
  assert.deepEqual(parser.parse(source), full);
  options.simple = false;
  assert.deepEqual(parser.parse(source, options), full);
  assert.deepEqual(parser.parse('', { simple: true }), { type: 'document', entries: [], definitions: [] });
});

test('simple conversion is iterative and does not mutate the source tree or share mutable binding/category metadata', () => {
  const leaf = (type: T): Node => ({ type, content: 'template', raw: 'template', start: 0, end: 8, children: [] });
  const root = leaf(T.ROOT);
  let tail = root;
  for (let index = 0; index < 12000; index++) {
    const child = leaf(T.OPTIONAL);
    tail.children = [child];
    tail = child;
  }
  tail.binding = { name: 'item', kind: 'WHERE' };
  tail.categories = ['SQL'];
  const simple = simpleNode(root);
  const all = nodes(simple);
  assert.equal(all.length, 12001);
  assert.ok(all.every(node => !Object.hasOwn(node, 'raw') && !Object.hasOwn(node, 'content')));
  assert.equal(root.raw, 'template');
  assert.equal(tail.content, 'template');
  all.at(-1)!.binding!.name = 'changed';
  all.at(-1)!.categories!.push('COMPOUND');
  assert.equal(tail.binding.name, 'item');
  assert.deepEqual(tail.categories, ['SQL']);
});

test('a real expanded PostgreSQL template produces smaller serializable JSON with the same runtime UIDs', () => {
  const source = readFileSync(new URL('../../postgresql/create/table.snf', import.meta.url), 'utf8');
  const parser = new SNFDocumentParser();
  const full = parser.parse(source), simple = parser.parse(source, { simple: true });
  const fullNodes = [...full.entries, ...full.definitions].flatMap(item => nodes(item.ast));
  const simpleNodes = [...simple.entries, ...simple.definitions].flatMap(item => nodes(item.ast));
  assert.deepEqual(simpleNodes.map(node => node.uid), fullNodes.map(node => node.uid));
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const simpleBytes = Buffer.byteLength(JSON.stringify(simple));
  assert.ok(simpleBytes < fullBytes);
  assert.equal(JSON.parse(JSON.stringify(simple)).definitions.length, full.definitions.length);
  console.log(`PostgreSQL create/table JSON: ${fullBytes} -> ${simpleBytes} bytes (${(100 * (1 - simpleBytes / fullBytes)).toFixed(1)}% smaller).`);
});

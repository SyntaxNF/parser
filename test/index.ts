import assert from 'node:assert/strict';
import {
  addEnumName,
  addLoopName,
  cleanBlank,
  cleanSingleBlank,
  collectName,
  copyNode,
  createAddUid,
  DocumentLineType,
  ExchangeType,
  exchangeLoopNode,
  exchangeQuoteNode,
  Node,
  NodeType,
  SNFDocumentParser,
  SNFParseError,
  SNFParser,
  walk,
  walkDocument,
} from '../src/index';

const collect = (root: Node, type: NodeType): Node[] => {
  const result: Node[] = [];
  walk(root, {
    back: (node) => {
      if (node.type === type) result.push(node);
    },
  });
  if (root.type === type) result.push(root);
  return result;
};

const assertRawRanges = (root: Node, source: string): void => {
  assert.equal(root.raw, source.slice(root.start, root.end));
  walk(root, {
    back: (node) => {
      assert.equal(node.raw, source.slice(node.start, node.end));
    },
  });
};

const parser = new SNFParser();

for (const exchangeType of Object.values(ExchangeType)) {
  let rootVisits = 0;
  const assertParent = (node: Node, parent: Node | undefined) => {
    if (node.type === NodeType.ROOT) {
      assert.equal(parent, undefined, 'root has no parent');
      rootVisits++;
    } else {
      assert.equal(parent?.type, NodeType.ROOT);
    }
  };
  walk(parser.parse('SELECT value'), {
    includeRoot: true,
    exchangeType,
    exchange: (node, parent, context) => {
      assert.equal(parent, context.parent);
      assertParent(node, parent);
    },
    back: assertParent,
  });
  assert.equal(rootVisits, exchangeType === ExchangeType.BOTH ? 3 : 2);
}

const compactSource = 'CREATE [OR REPLACE] FUNCTION name ([arg[, ...]])';
const compactAst = parser.parse(compactSource);
assert.equal(compactAst.raw, compactSource);
assertRawRanges(compactAst, compactSource);
assert.equal(collect(compactAst, NodeType.REPEAT).length, 1);
assert.equal(collect(compactAst, NodeType.LOOP).length, 1);

const qualifiedNameAst = parser.parse('table.colname');
assert.equal(qualifiedNameAst.children?.map((node) => node.content).join(''), 'table.colname');

const numericEnumAst = parser.parse('{ 0 | 1 | 123 }');
assert.deepEqual(
  collect(numericEnumAst, NodeType.NUMBER).map((node) => node.content),
  ['0', '1', '123'],
);

// Square brackets preserve a sequence; only explicit braces introduce choices.
const optionalSource = '[ LIMIT count ]';
const optionalAst = parser.parse(optionalSource);
assertRawRanges(optionalAst, optionalSource);
const optional = cleanBlank(optionalAst).children![0];
assert.equal(optional.type, NodeType.OPTIONAL);
assert.deepEqual(optional.children?.map((node) => [node.type, node.content]), [
  [NodeType.DEFINITION, 'LIMIT'],
  [NodeType.VARIABLE, 'count'],
]);
assert.equal(collect(optionalAst, NodeType.ENUM).length, 0);
assert.equal(collect(optionalAst, NodeType.GROUP).length, 0);

const optionalEnumSource = '[ { ASC | DESC } ]';
const optionalEnumAst = parser.parse(optionalEnumSource);
assertRawRanges(optionalEnumAst, optionalEnumSource);
const optionalEnum = cleanBlank(optionalEnumAst).children![0].children![0];
assert.equal(optionalEnum.type, NodeType.ENUM);
assert.deepEqual(optionalEnum.children?.map((group) => [group.type, group.children![0].content]), [
  [NodeType.GROUP, 'ASC'],
  [NodeType.GROUP, 'DESC'],
]);
assert.equal(optionalEnum.raw, '{ ASC | DESC }');

for (const source of ['[ [ a ] ]', '{ [ A ] | [ { B | C } ] }', '{ A }', '{ | A || }']) {
  const ast = parser.parse(source);
  assertRawRanges(ast, source);
  walk(ast, {
    exchange(node, parent) {
      if (node.type === NodeType.GROUP) assert.equal(parent?.type, NodeType.ENUM);
    },
  });
}
assert.equal(collect(parser.parse('[ [ a ] ]'), NodeType.ENUM).length, 0);
assert.equal(collect(parser.parse('{ A }'), NodeType.GROUP).length, 1);
const emptyChoices = cleanBlank(parser.parse('{ | A || }')).children![0].children!;
assert.deepEqual(emptyChoices.map((group) => group.children!.map((node) => node.content)), [[], ['A'], [], []]);

for (const source of ['A | B', '[ A | B ]', '{ [ A | B ] }', '[ { A | B } | C ]', 'item [, ... | other]']) {
  assert.throws(
    () => parser.parse(source),
    (error: unknown) => error instanceof SNFParseError
      && error.offset === source.lastIndexOf('|')
      && error.expected === '{ ... | ... }',
  );
}
assert.throws(
  () => parser.parse('[ A\n  | B ]'),
  (error: unknown) => error instanceof SNFParseError && error.line === 2 && error.column === 3,
);

for (const source of [String.raw`A \| B`, String.raw`[ a\|b ]`, String.raw`{ A\|B | C }`, String.raw`[ \[ \{ \| \} \] ]`]) {
  const ast = parser.parse(source);
  assertRawRanges(ast, source);
  assert.equal(collect(ast, NodeType.SPLIT).length, 0);
}
assert.equal(collect(parser.parse(String.raw`[ a\|b ]`), NodeType.VARIABLE)[0].content, 'a|b');

// Lowercase words remain ordinary variables; only opt-in walkers add names.
for (const source of ['{ value as item }', '[ value as item ]', '[ { value as item } ]']) {
  const ast = parser.parse(source);
  assertRawRanges(ast, source);
  assert.deepEqual(collect(ast, NodeType.VARIABLE).map((node) => node.content), ['value', 'as', 'item']);
  walk(ast, { includeRoot: true, exchange: (node) => { assert.equal(node.name, undefined); } });
}

// Explicit choices and direct optional sequences can both be repeated.
for (const [source, memberType] of [
  ['item[...]', NodeType.VARIABLE],
  ['item[, ...]', NodeType.VARIABLE],
  ['{ a | b } [, ...]', NodeType.ENUM],
  ['[ NEXT item ] [...]', NodeType.OPTIONAL],
] as const) {
  const ast = parser.parse(source);
  assertRawRanges(ast, source);
  const loops = collect(exchangeLoopNode(ast), NodeType.LOOP);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].children![0].type, memberType);
  assert.equal(Array.isArray(loops[0].ast), true);
}

assert.throws(
  () => parser.parse('name\\'),
  (error: unknown) => error instanceof SNFParseError && error.offset === 4 && error.line === 1 && error.column === 5,
);
assert.throws(() => parser.parse('{ A } }'), SNFParseError);
assert.throws(() => parser.parse('[ A'), SNFParseError);
assert.throws(() => parser.parse('[....]'), SNFParseError);

const nestedAst = parser.parse('{ A | { B | C } }');
const nestedBeforeClean = JSON.stringify(nestedAst);
const cleanedNestedAst = cleanBlank(nestedAst);
assert.equal(JSON.stringify(nestedAst), nestedBeforeClean, 'cleanBlank must not mutate its input');
assert.equal(collect(cleanedNestedAst, NodeType.BLANK).length, 0);

const walkContexts: Array<[string, number, string | undefined, number]> = [];
const contextAst = walk(parser.parse('A B'), {
  includeRoot: true,
  exchange: (node, _parent, context) => {
    walkContexts.push([node.content, context.index, context.key, context.ancestors.length]);
    return node;
  },
  exchangeChildren: (children) => children.filter((node) => node.type !== NodeType.BLANK),
});
assert.deepEqual(contextAst.children?.map((node) => node.content), ['A', 'B']);
assert.deepEqual(walkContexts[0], ['A B', 0, undefined, 0]);
assert.deepEqual(walkContexts[1], ['A', 0, 'children', 1]);

const documentSource = [
  '# https://example.com/syntax',
  '',
  '# PARTOFIS item',
  'FIRST value',
  '',
  'SECOND value',
].join('\n');
const documentParser = new SNFDocumentParser();
const document = documentParser.parse(documentSource);
assert.equal(document.content, documentSource);
assert.equal(document.lines.filter((line) => line.type === DocumentLineType.BLANK).length, 2);
assert.equal(document.blocks.length, 3);
assert.equal(document.blocks[0].comment, '# https://example.com/syntax');
assert.equal(document.blocks[1].comment, '# PARTOFIS item');
assert.equal(document.blocks[2].comment, '');
assert.equal(document.blocks[2].content, 'SECOND value');
assert.deepEqual(
  document.blocks.map((block) => [block.startLine, block.endLine]),
  [
    [1, 1],
    [3, 4],
    [6, 6],
  ],
);

const cleanedDocument = walkDocument(document, cleanBlank);
assert.notEqual(cleanedDocument, document);
assert.equal(collect(document.blocks[1].ast, NodeType.BLANK).length > 0, true);
assert.equal(collect(cleanedDocument.blocks[1].ast, NodeType.BLANK).length, 0);

const indentedAst = parser.parse('  CREATE TABLE name');
const cleanedSingleBlankAst = cleanSingleBlank(indentedAst);
assert.deepEqual(
  collect(cleanedSingleBlankAst, NodeType.BLANK).map((node) => node.content),
  ['  '],
);

const enumSource = 'MODE { A | B }';
const enumAst = parser.parse(enumSource);
const namedEnumAst = addEnumName(enumAst);
assert.equal(collect(namedEnumAst, NodeType.ENUM)[0].name, 'MODE');
assert.equal(JSON.stringify(enumAst).includes('"name":"MODE"'), false, 'addEnumName must not mutate its input');

const loopSource = 'item [, ...]';
const namedLoopAst = addLoopName(parser.parse(loopSource));
assert.equal(collect(namedLoopAst, NodeType.LOOP)[0].name, 'items');
const loopBeforeExchange = JSON.stringify(namedLoopAst);
const exchangedLoopAst = exchangeLoopNode(namedLoopAst);
const exchangedLoop = collect(exchangedLoopAst, NodeType.LOOP)[0];
assert.equal(JSON.stringify(namedLoopAst), loopBeforeExchange, 'exchangeLoopNode must not mutate its input');
assert.equal(exchangedLoop.children?.some((node) => node.type === NodeType.VARIABLE), true);
assert.equal(Array.isArray(exchangedLoop.ast), true);
assert.deepEqual(collectName(exchangedLoopAst), ['items[]', 'items[].item']);

const optionalLoopAst = exchangeLoopNode(parser.parse('item [ NEXT item ] [...]'));
const optionalLoop = collect(optionalLoopAst, NodeType.LOOP)[0];
assert.equal(optionalLoop.children?.some((node) => node.type === NodeType.OPTIONAL), true);

const quotedAst = exchangeQuoteNode(parser.parse(`COMMENT 'comment' "label"`));
assert.equal(collect(quotedAst, NodeType.QUOTE).length, 0);
assert.equal(collect(quotedAst, NodeType.DOUBLEQUOTE).length, 0);
assert.deepEqual(
  collect(quotedAst, NodeType.VARIABLE).map((node) => [node.content, node.quote]),
  [
    ['comment', `'`],
    ['label', `"`],
  ],
);

const copiedAst = copyNode(quotedAst);
assert.notEqual(copiedAst, quotedAst);
assert.notEqual(copiedAst.children, quotedAst.children);
const copiedLoopAst = copyNode(exchangedLoopAst);
assert.notEqual(collect(copiedLoopAst, NodeType.LOOP)[0].ast, exchangedLoop.ast);

const uidAst = createAddUid()(exchangedLoopAst);
assert.match(uidAst.uid!, /^RO00-0000-[0-9A-F]{32}-0000$/);
const uidNodes = [uidAst, ...collect(uidAst, NodeType.VARIABLE), ...collect(uidAst, NodeType.LOOP)];
assert.equal(uidNodes.every((node) => /^[A-Z]{2}[0-9A-F]{2}-[0-9A-F]{4}-[0-9A-F]{32}-[0-9A-F]{4}$/.test(node.uid ?? '')), true);
assert.equal(new Set(uidNodes.map((node) => node.uid)).size, uidNodes.length);

console.log('Base parser tests passed.');

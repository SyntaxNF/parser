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
    (key, value) => ['uid', 'name', 'indentLevel'].includes(key) ? undefined :
      Array.isArray(value) ? value.filter(node => ![T.BLANK, T.WRAP].includes(node.type)) : value,
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

test('horizontal layout collapses inline blanks, preserves indentation and removes trailing blanks', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const source = ` \tSELECT\t  value \t${ending}    FROM   table\t${ending}\t WHERE  other   `;
    const expected = ` \tSELECT value${ending}    FROM table${ending}\t WHERE other`;
    const ast = new SNFParser().parse(source);
    const all = nodes(ast);
    assert.equal(all.filter(node => !node.children).map(node => node.content).join(''), expected);
    assert.deepEqual(all.filter(node => node.type === T.BLANK).map(node => node.content), [' \t', ' ', '    ', ' ', '\t ', ' ']);
    assert.ok(all.some(node => node.type === T.BLANK && node.raw === '\t  ' && node.content === ' '));
    for (const node of all) assert.equal(node.raw, source.slice(node.start, node.end));
    const significant = (source: string) => nodes(new SNFParser().parse(source))
      .filter(node => ![T.BLANK, T.WRAP].includes(node.type)).map(node => node.uid);
    assert.deepEqual(significant(source), significant(expected));
  }
});

test('container boundaries do not count as physical line boundaries', () => {
  const source = '[   A   \r\n    B  ]\r\n{   C   |   D   }   ';
  const ast = new SNFParser().parse(source);
  const optional = nodes(ast).find(node => node.type === T.OPTIONAL)!;
  assert.deepEqual(optional.children!.filter(node => node.type === T.BLANK).map(node => node.content), ['    ']);
  assert.ok(!nodes(ast).some(node => node.type === T.BLANK && node.end === source.length));
  for (const group of nodes(ast).filter(node => node.type === T.GROUP))
    assert.deepEqual(group.children!.filter(node => node.type === T.BLANK).map(node => node.content), []);
  for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('quoted text preserves whitespace through nested syntax while outside layout is normalized', () => {
  const source = `A   ' B  \n    [ C   value   ]   { D  | E }   " F  "  '   Z   `;
  const ast = new SNFParser().parse(source);
  const quoted = ast.children!.find(node => node.type === T.QUOTED)!;
  assert.ok(nodes(quoted).filter(node => node.type === T.BLANK).every(node => node.content === node.raw));
  assert.ok(nodes(quoted).some(node => node.type === T.BLANK && node.content === '    '));
  assert.deepEqual(ast.children!.filter(node => node.type === T.BLANK).map(node => node.content), [' ', ' ']);
  for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('blank lines lose horizontal blanks but retain their original line breaks', () => {
  const source = ' \t \r\n  \n\t';
  const ast = new SNFParser().parse(source);
  assert.ok(ast.children!.every(node => node.type === T.WRAP));
  assert.equal(ast.children!.map(node => node.content).join(''), '\r\n\n');
  for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('loop binding preserves preceding indentation after whitespace normalization', () => {
  const source = '   item   [,\t...]\t  \n    other\t ';
  const ast = new SNFParser().parse(source);
  assert.deepEqual(ast.children!.map(node => node.type), [T.BLANK, T.LOOP, T.WRAP, T.BLANK, T.VARIABLE]);
  assert.deepEqual(ast.children!.filter(node => node.type === T.BLANK).map(node => node.content), ['', ' ']);
  assert.deepEqual(ast.children!.filter(node => node.type === T.BLANK).map(node => node.indentLevel), [0, 0.25]);
  assert.equal(ast.children![1].separator, ',');
  assert.equal(ast.children![1].children![0].content, 'item');
  for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('document fragments and expanded definitions preserve whitespace source offsets', () => {
  const source = '# CASE A\r\n  SELECT   item  \r\n\r\n# WHERE item\r\n    value   [ LIMIT   count ]  \r\n\r\n# ONEOFIS choice\r\n    A   input   \r\n\tB\tother\t\r\n';
  const doc = new SNFDocumentParser().parse(source);
  assert.equal(doc.lines.map(line => line.content + line.ending).join(''), source);
  for (const item of [...doc.entries, ...doc.definitions])
    for (const node of nodes(item.ast))
      if (!node.synthetic) assert.equal(node.raw, doc.blocks[node.sourceBlock!].content.slice(node.start, node.end));
  const definition = doc.definitions.find(item => item.names.includes('item'))!;
  assert.deepEqual(definition.ast.children!.filter(node => node.type === T.BLANK).map(node => node.content), ['', ' ']);
  const expanded = nodes(doc.entries[0].ast).find(node => node.type === T.COLLECTION)!;
  assert.equal(expanded.children![0].content, '');
  const choices = doc.definitions.find(item => item.names.includes('choice'))!.ast.children![0].children!;
  assert.deepEqual(choices.map(group => group.children!.filter(node => node.type === T.BLANK).map(node => node.content)), [['', ' '], ['', ' ']]);
});

test('escaped text and error locations are unaffected by layout normalization', () => {
  const source = 'A value\\ \nB';
  const ast = new SNFParser().parse(source);
  assert.equal(nodes(ast).find(node => node.type === T.VARIABLE)!.content, 'value ');
  for (const node of nodes(ast)) assert.equal(node.raw, source.slice(node.start, node.end));
  const invalid = '# CASE A\r\n  SELECT   [ A   | B ]\r\n';
  assert.throws(() => new SNFDocumentParser().parse(invalid), (error: unknown) =>
    error instanceof SNFParseError && error.offset === invalid.indexOf('|') && error.line === 2,
  );
});

test('boundary trimming runs after expansion and protects quoted helper instances', () => {
  const source = `SELECT item 'item' [ { A input | B input } ]\n\n# WHERE item\nFIRST value [ LAST other ]`;
  for (const simple of [false, true]) {
    const doc = new SNFDocumentParser().parse(source, { simple });
    const optional = doc.definitions[0].ast.children!.find(node => node.type === T.OPTIONAL)!;
    assert.deepEqual(optional.children!.map(node => node.content), ['LAST', ' ', 'other']);
    const quote = doc.entries[0].ast.children!.find(node => node.type === T.QUOTED)!;
    const quotedHelper = quote.children!.find(node => node.type === T.COLLECTION)!;
    const quotedOptional = quotedHelper.children!.find(node => node.type === T.OPTIONAL)!;
    assert.deepEqual(quotedOptional.children!.map(node => node.content), [' ', 'LAST', ' ', 'other', ' ']);
    assert.equal(doc.definitions[0].ast.children!.filter(node => node.type === T.BLANK).length, 2);
    assert.deepEqual(new SNFDocumentParser().parse(source, { simple }), doc);
  }
});

test('full and simple fragments trim only optional/group padding, keeping internal spacing and joins', () => {
  for (const simple of [false, true]) {
    const ast = new SNFParser().parse("SELECT [ DISTINCT column ] { schema.table | N'language' } item [ OR ELSE ... ]", { simple });
    const optional = ast.children!.find(node => node.type === T.OPTIONAL)!;
    assert.deepEqual(optional.children!.map(node => node.content), ['DISTINCT', ' ', 'column']);
    const groups = ast.children!.find(node => node.type === T.ENUM)!.children!;
    assert.deepEqual(groups[0].children!.map(node => node.content), ['schema', '.', 'table']);
    assert.deepEqual(groups[1].children!.map(node => node.type), [T.DEFINITION, T.QUOTED]);
    assert.ok(ast.children!.some(node => node.type === T.BLANK && node.content === ' '));
    assert.equal(ast.children!.at(-1)!.separator, 'OR ELSE');
  }
});

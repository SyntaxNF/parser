import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Node, NodeType as T, SNFDocumentParser, SNFParser } from '../src/index';
import { nodes } from './helpers';
import { createIdentityAllocator } from '../src/internal/identity';

interface Options {
  include?: (node: Node) => boolean;
  choose?: (node: Node) => number;
  count?: (node: Node) => number;
}

// A layout-contract fixture, not an SQL formatter or a database semantic validator.
function render(root: Node, options: Options = {}): string {
  let output = '', lineStart = true, space = false;
  const emit = (value: string, level: number, literal: boolean) => {
    for (const char of value) {
      if (literal) {
        output += char;
        lineStart = char === '\n' || char === '\r';
        continue;
      }
      if (char === '\r' || char === '\n') {
        if (!lineStart) output += '\n';
        lineStart = true;
        space = false;
      } else if (char === ' ' || char === '\t') {
        if (!lineStart) space = true;
      } else {
        if (lineStart) output += ' '.repeat(level * 4);
        else if (space) output += ' ';
        output += char;
        lineStart = space = false;
      }
    }
  };
  const visit = (node: Node, literal = false): void => {
    const level = node.indentLevel ?? 0;
    if (node.type === T.OPTIONAL && options.include && !options.include(node)) return;
    if (node.type === T.ENUM) return visit(node.children![options.choose?.(node) ?? 0], literal);
    if (node.type === T.QUOTED) {
      emit(node.quote!, level, literal);
      node.children!.forEach(child => visit(child, true));
      emit(node.quote!, level, true);
      return;
    }
    if (node.type === T.LOOP) {
      for (let index = 0; index < (options.count?.(node) ?? 1); index++) {
        if (index) {
          output = output.replace(/[ \t\r\n]+$/, '');
          lineStart = space = false;
          emit(node.separator!, level, literal);
          emit('\n', level, literal);
        }
        visit(node.children![0], literal);
      }
      return;
    }
    if (node.children) node.children.forEach(child => visit(child, literal));
    else emit(node.content, level, literal);
  };
  visit(root);
  return output.trimEnd();
}

const parse = (source: string) => new SNFParser().parse(source);
const document = (source: string) => new SNFDocumentParser().parse(source);
const file = (repo: string, name: string) => document(readFileSync(new URL(`../../${repo}/${name}`, import.meta.url), 'utf8'));

test('a standalone SNF enumeration removes its extra indentation without affecting SQL parentheses', () => {
  const source = 'CREATE TABLE name (\n    {\n        item |\n        other\n    } [, ...]\n)';
  const ast = parse(source);
  for (const choice of [0, 1]) {
    const value = choice ? 'other' : 'item';
    assert.equal(render(ast, { choose: () => choice, count: () => 2 }), `CREATE TABLE name (\n    ${value},\n    ${value}\n)`);
  }
  for (const node of nodes(ast))
    if (!node.synthetic) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('the mixed SQL and SNF opener preserves two levels inside the real parentheses', () => {
  const ast = parse('CREATE TABLE name OF type\n    [ ( {\n        item |\n        other\n    } [, ...] ) ]');
  for (const choice of [0, 1]) {
    const value = choice ? 'other' : 'item';
    assert.equal(render(ast, { choose: () => choice, count: () => 2 }), `CREATE TABLE name OF type\n    (\n        ${value},\n        ${value}\n    )`);
  }
});

test('multiple SNF delimiters on one line deduct one frame, while nested physical lines deduct their own frames', () => {
  for (const source of [
    'HEAD\n    [ {\n        item |\n        other\n    } ]\nTAIL',
    'HEAD\n    {\n        [\n            item\n        ]\n    }\nTAIL',
  ]) assert.equal(render(parse(source)), 'HEAD\n    item\nTAIL');
  assert.equal(render(parse('HEAD\n    [ AS {\n        item |\n        other\n    } ]\nTAIL')), 'HEAD\n    AS\n        item\nTAIL');
});

test('whole-fragment indentation is relative and real BEGIN END layout is retained', () => {
  const source = '    BEGIN\n        value\n    END';
  const ast = parse(source);
  assert.equal(render(ast), 'BEGIN\n    value\nEND');
  assert.equal(nodes(ast).find(node => node.type === T.VARIABLE)!.indentLevel, 1);
  for (const node of nodes(ast)) if (!node.synthetic) assert.equal(node.raw, source.slice(node.start, node.end));
});

test('helper continuation and zero-indented END lines rebase to the caller line, not the caller column', () => {
  const source = 'BEGIN\n    body\nEND\n\n# WHERE body\nBEGIN\n    value\nEND';
  assert.equal(render(document(source).entries[0].ast), 'BEGIN\n    BEGIN\n        value\n    END\nEND');
  const inline = document('CREATE VIEW name AS query\n\n# WHERE query\nSELECT value\n    FROM table');
  assert.equal(render(inline.entries[0].ast), 'CREATE VIEW name AS SELECT value\n    FROM table');
});

test('a helper containing an enum does not accumulate its wrapper indentation at repeated call sites', () => {
  const doc = document('BEGIN\n    body [...]\nEND\n\n# WHERE body\n{\n    block |\n    value\n}\n\n# WHERE block\nBEGIN\n    item\nEND');
  assert.equal(render(doc.entries[0].ast, { count: () => 2 }), 'BEGIN\n    BEGIN\n        item\n    END\n    BEGIN\n        item\n    END\nEND');
  assert.equal(render(doc.entries[0].ast, { count: () => 0 }), 'BEGIN\nEND');
});

test('recursive references retain the caller anchor while canonical target definitions stay relative', () => {
  const doc = document('BEGIN\n    body\nEND\n\n# PARTOFIS body\nvalue\n\nBEGIN\n    body\nEND');
  const reference = nodes(doc.entries[0].ast).find(node => node.type === T.REFERENCE)!;
  assert.equal(reference.indentLevel, 1);
  assert.equal(reference.target, doc.definitions[0].ast.uid);
  const nested = nodes(doc.definitions[0].ast).find(node => node.type === T.REFERENCE)!;
  assert.equal(nested.indentLevel, 1);
  assert.equal(doc.definitions[0].ast.indentLevel, undefined);
});

test('multiline alternatives share their boundary layout even when another branch is written inline', () => {
  const ast = parse('MODE { A |\n    B }\nTAIL');
  assert.equal(render(ast), 'MODE A\nTAIL');
  assert.equal(render(ast, { choose: () => 1 }), 'MODE B\nTAIL');
});

test('quoted whitespace, including nested syntax, is unaffected by indentation rebasing', () => {
  const source = `HEAD\n    ' A   \n  B '\nTAIL`;
  assert.equal(render(parse(source)), source);
  const ast = parse(`HEAD\n    ' A [ B  ] { C  | D } '\nTAIL`);
  const quote = nodes(ast).find(node => node.type === T.QUOTED)!;
  assert.ok(nodes(quote).filter(node => node !== quote).every(node => node.indentLevel === undefined));
  assert.ok(nodes(quote).filter(node => node.type === T.BLANK).every(node => node.content === node.raw));
});

test('PostgreSQL NORMAL and TYPE column blocks consistently use the statement-line opening parentheses', () => {
  const doc = file('postgresql', 'create/table.snf');
  const count = (node: Node) => /(?:typed_)?column_definition \|/.test(node.children![0].raw) ? 2 : 0;
  const normal = doc.entries.find(entry => entry.name === 'NORMAL')!.ast;
  assert.equal(render(normal, { include: () => false, count }), 'CREATE TABLE name (\n    colname type,\n    colname type\n)');
  const typed = doc.entries.find(entry => entry.name === 'TYPE')!.ast;
  assert.equal(render(typed, { include: node =>
    (node.name === '(' && nodes(node).some(child => child.binding?.name === 'typed_column_definition')) || node.raw === '[ WITH OPTIONS ]', count }),
    'CREATE TABLE name OF type (\n    colname WITH OPTIONS,\n    colname WITH OPTIONS\n)');
});

test('SQL Server helper enums and MySQL definition alternatives inherit the table member indentation', () => {
  for (const repo of ['sqlserver', 'mysql']) {
    const ast = file(repo, 'create/table.snf').entries[0].ast;
    const member = repo === 'sqlserver' ? 'table_element_definition' : 'create_definition';
    const result = render(ast, { include: () => false, count: node => node.children![0].binding?.name === member ? 2 : 0 });
    assert.ok(result.startsWith('CREATE TABLE name (\n    colname '));
    assert.ok(!result.includes('\n        colname '));
    assert.ok(result.includes(',\n    colname '));
  }
});

test('Oracle package helper alternatives preserve declaration and continuation indentation', () => {
  const ast = file('oracle', 'create/package.snf').entries[0].ast;
  const result = render(ast, {
    include: () => false,
    choose: node => node.children?.some(group => group.raw.includes('FUNCTION function_name')) ? 1 : 0,
    count: node => node.children![0].binding?.name === 'package_item_definition' ? 2 : 0,
  });
  assert.ok(result.includes('\n    FUNCTION function_name'));
  assert.ok(result.endsWith('\nEND ;'));
});

test('indent metadata remains deterministic, does not influence UID reassignment and retains definition source spans', () => {
  const source = 'BEGIN\n    body\nEND\n\n# WHERE body\nBEGIN\n    item\nEND';
  const doc = document(source);
  assert.deepEqual(document(source), doc);
  const all = [...doc.entries, ...doc.definitions].flatMap(item => nodes(item.ast));
  assert.equal(new Set(all.map(node => node.uid)).size, all.length);
  for (const node of all) {
    if (node.indentLevel !== undefined) assert.ok(Number.isFinite(node.indentLevel) && node.indentLevel >= 0);
    if (!node.synthetic) assert.equal(node.raw, doc.blocks[node.sourceBlock!].content.slice(node.start, node.end));
  }
  const changed = structuredClone(doc);
  const identify = createIdentityAllocator();
  for (const item of [...changed.entries, ...changed.definitions])
    for (const node of nodes(item.ast)) node.indentLevel = (node.indentLevel ?? 0) + 100;
  const reassigned = [...changed.entries, ...changed.definitions].flatMap(item => nodes(identify(item.ast)));
  assert.deepEqual(reassigned.map(node => node.uid), all.map(node => node.uid));
});

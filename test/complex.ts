import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import { Node, NodeType, SNFDocumentParser } from '../src/index';

interface ComplexCase {
  name: string;
  file: string;
  minBlocks: number;
  minDepth: number;
  requiredTypes: NodeType[];
}

interface AstMetrics {
  depth: number;
  nodes: number;
  types: Map<NodeType, number>;
}

const mysqlRoot = process.env.SNF_MYSQL_ROOT ?? path.resolve(import.meta.dirname, '../../mysql');
const postgresqlRoot = process.env.SNF_POSTGRESQL_ROOT ?? path.resolve(import.meta.dirname, '../../postgresql');

const cases: ComplexCase[] = [
  {
    name: 'MySQL CREATE TABLE',
    file: path.join(mysqlRoot, 'create/table.snf'),
    minBlocks: 12,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.QUOTE, NodeType.WRAP],
  },
  {
    name: 'MySQL SELECT',
    file: path.join(mysqlRoot, 'query/select.snf'),
    minBlocks: 10,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.QUOTE, NodeType.WRAP],
  },
  {
    name: 'MySQL CREATE USER',
    file: path.join(mysqlRoot, 'create/user.snf'),
    minBlocks: 8,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.QUOTE, NodeType.WRAP],
  },
  {
    name: 'MySQL CHANGE REPLICATION SOURCE',
    file: path.join(mysqlRoot, 'replication/change-source.snf'),
    minBlocks: 30,
    minDepth: 4,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.QUOTE],
  },
  {
    name: 'PostgreSQL CREATE TABLE',
    file: path.join(postgresqlRoot, 'create/table.snf'),
    minBlocks: 10,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.WRAP],
  },
  {
    name: 'PostgreSQL CREATE FOREIGN TABLE',
    file: path.join(postgresqlRoot, 'create/foreign-table.snf'),
    minBlocks: 8,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT, NodeType.QUOTE, NodeType.WRAP],
  },
  {
    name: 'PostgreSQL CREATE EVENT TRIGGER',
    file: path.join(postgresqlRoot, 'create/event-trigger.snf'),
    minBlocks: 2,
    minDepth: 5,
    requiredTypes: [NodeType.OPTIONAL, NodeType.ENUM, NodeType.LOOP, NodeType.REPEAT],
  },
];

const inspectNode = (node: Node, source: string, parent?: Node): AstMetrics => {
  assert.equal(node.raw, source.slice(node.start, node.end), `${node.type} raw source range must be exact`);
  assert.equal(node.start >= 0, true, `${node.type} start must be non-negative`);
  assert.equal(node.end >= node.start, true, `${node.type} range must be ordered`);
  assert.equal(node.end <= source.length, true, `${node.type} end must stay inside its block`);

  if (parent) {
    assert.equal(node.start >= parent.start, true, `${node.type} must start inside its parent`);
    assert.equal(node.end <= parent.end, true, `${node.type} must end inside its parent`);
  }

  const metrics: AstMetrics = {
    depth: 1,
    nodes: 1,
    types: new Map([[node.type, 1]]),
  };

  for (const child of node.children ?? []) {
    const childMetrics = inspectNode(child, source, node);
    metrics.depth = Math.max(metrics.depth, childMetrics.depth + 1);
    metrics.nodes += childMetrics.nodes;
    for (const [type, count] of childMetrics.types) {
      metrics.types.set(type, (metrics.types.get(type) ?? 0) + count);
    }
  }

  return metrics;
};

const parser = new SNFDocumentParser();
let sourceLines = 0;
let sourceBytes = 0;
let parsedBlocks = 0;
let parsedNodes = 0;

for (const each of cases) {
  const source = await fs.readFile(each.file, 'utf8');
  const document = parser.parse(source);

  assert.equal(
    document.lines.map((line) => line.content + line.ending).join(''),
    source,
    `${each.name} physical lines must reconstruct the source`,
  );
  assert.equal(document.blocks.length >= each.minBlocks, true, `${each.name} must retain its document blocks`);

  const caseTypes = new Map<NodeType, number>();
  let caseDepth = 0;
  let caseNodes = 0;

  for (const line of document.lines) {
    assert.equal(source.slice(line.start, line.end), line.content + line.ending, `${each.name} line range must be exact`);
  }

  for (const block of document.blocks) {
    assert.equal(
      source.slice(block.start, block.end),
      block.lines.map((line) => line.content + line.ending).join(''),
      `${each.name} block range must be exact`,
    );
    assert.equal(block.ast.raw, block.content, `${each.name} root AST must preserve block content`);

    const metrics = inspectNode(block.ast, block.content);
    caseDepth = Math.max(caseDepth, metrics.depth);
    caseNodes += metrics.nodes;
    for (const [type, count] of metrics.types) {
      caseTypes.set(type, (caseTypes.get(type) ?? 0) + count);
    }
  }

  assert.equal(caseDepth >= each.minDepth, true, `${each.name} must retain nested syntax depth`);
  for (const type of each.requiredTypes) {
    assert.equal((caseTypes.get(type) ?? 0) > 0, true, `${each.name} must contain ${type} nodes`);
  }

  sourceLines += document.lines.length;
  sourceBytes += Buffer.byteLength(source);
  parsedBlocks += document.blocks.length;
  parsedNodes += caseNodes;
  console.log(`${each.name}: ${document.lines.length} lines, ${document.blocks.length} blocks, ${caseNodes} nodes, depth ${caseDepth}`);
}

console.log(
  `Complex examples passed: ${cases.length} files, ${sourceLines} lines, ${sourceBytes} bytes, ${parsedBlocks} blocks, ${parsedNodes} AST nodes.`,
);

const repositoryFiles = await glob(
  [path.join(mysqlRoot, '**/*.snf'), path.join(postgresqlRoot, '**/*.snf')],
  { nodir: true },
);
let repositoryLines = 0;
let repositoryBlocks = 0;
let repositoryNodes = 0;

for (const file of repositoryFiles) {
  const source = await fs.readFile(file, 'utf8');
  const document = parser.parse(source);
  assert.equal(
    document.lines.map((line) => line.content + line.ending).join(''),
    source,
    `${file} physical lines must reconstruct the source`,
  );

  repositoryLines += document.lines.length;
  repositoryBlocks += document.blocks.length;
  for (const block of document.blocks) {
    repositoryNodes += inspectNode(block.ast, block.content).nodes;
  }
}

console.log(
  `Full repositories passed: ${repositoryFiles.length} files, ${repositoryLines} lines, ${repositoryBlocks} blocks, ${repositoryNodes} AST nodes.`,
);

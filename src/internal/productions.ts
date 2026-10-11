import { Block, DefinitionKind, DocumentLineType, Node, NodeType } from '../type';
import { SNFParseError } from '../error';
import { SyntaxParser } from './syntax';
import { normalize } from './normalize';

type ProductionKind = DefinitionKind | 'CASE' | 'IMPLICIT';

interface Declaration {
  kind: ProductionKind;
  names: string[];
  blocks: number[];
}

export interface Production extends Declaration {
  tree: Node;
  dependencies: string[];
}

export interface ProductionIndex {
  entries: Production[];
  definitions: Map<string, Production>;
}

type DeclarationError = (message: string, block: number) => never;
type ParseFragment = (text: string, block: number, offset?: number) => Node;

const directivePattern = /^# (CASE|WHERE|ONEOFIS|PARTOFIS|STATEMENT)(?:\s|$)/;
const caseNamePattern = /^[A-Z][A-Z0-9_]*$/;
const definitionNamePattern = /^[a-z][a-z0-9_]*$/;

/** Collect all names before parsing bodies so forward references and aliases resolve alike. */
export function buildProductions(content: string, blocks: Block[]): ProductionIndex {
  const fail: DeclarationError = (message, block) => {
    throw new SNFParseError(message, content, blocks[block]?.start ?? 0);
  };
  const declarations = readDeclarations(blocks, fail);
  const parse = createFragmentParser(content, blocks);
  const productions = declarations.map(declaration => ({
    ...declaration,
    tree: parseProduction(declaration, blocks, parse),
    dependencies: [] as string[],
  }));
  const entries: Production[] = [];
  const definitions = new Map<string, Production>();

  for (const production of productions) {
    if (production.kind === 'CASE' || production.kind === 'IMPLICIT') {
      entries.push(production);
    } else {
      for (const name of production.names) definitions.set(name, production);
    }
  }
  for (const production of productions) {
    production.dependencies = collectDependencies(production.tree, definitions);
  }
  return { entries, definitions };
}

function readDirective(block: Block, index: number, fail: DeclarationError): Declaration | undefined {
  const directives = block.comment.split('\n').filter(line => directivePattern.test(line));
  if (directives.length > 1) fail('Expected one directive per block', index);
  if (!directives.length) return;

  const match = /^# (CASE|WHERE|ONEOFIS|PARTOFIS|STATEMENT) (.+)$/.exec(directives[0]);
  if (!match) return fail('Malformed directive', index);
  const kind = match[1] as ProductionKind;
  const names = match[2].split(',').map(value => value.trim());
  const namePattern = kind === 'CASE' ? caseNamePattern : definitionNamePattern;
  if (names.some(name => !namePattern.test(name)) || (kind === 'CASE' && names.length !== 1)) {
    fail('Invalid directive name casing or aliases', index);
  }
  return { kind, names, blocks: [] };
}

function readDeclarations(blocks: Block[], fail: DeclarationError): Declaration[] {
  const declarations: Declaration[] = [];
  const cases = new Set<string>();
  const definitions = new Set<string>();
  let active: Declaration | undefined;

  for (const [index, block] of blocks.entries()) {
    const directive = readDirective(block, index, fail);
    if (directive) {
      active = directive;
      const registered = active.kind === 'CASE' ? cases : definitions;
      for (const name of active.names) {
        if (registered.has(name)) {
          fail(`Duplicate ${active.kind === 'CASE' ? 'CASE' : 'definition'} ${name}`, index);
        }
        registered.add(name);
      }
      declarations.push(active);
    } else if (!block.content.trim()) {
      continue;
    } else if (!active || active.kind === 'IMPLICIT') {
      if (cases.size) fail('Unowned continuation after CASE', index);
      active = { kind: 'IMPLICIT', names: [], blocks: [] };
      declarations.push(active);
    } else if (active.kind !== 'PARTOFIS' && active.kind !== 'ONEOFIS') {
      fail('Unowned continuation block', index);
    }

    active.blocks.push(index);
    if (!block.content.trim() && active.kind !== 'STATEMENT') {
      fail('Empty definition or entry', index);
    }
  }

  const firstEntry = declarations.find(item => item.kind === 'CASE' || item.kind === 'IMPLICIT');
  if (cases.size && declarations.some(item => item.kind === 'IMPLICIT')) {
    fail('Mixed implicit and CASE entry points', firstEntry!.blocks[0]);
  }
  return declarations;
}

/** Translate normalized block offsets back to physical document locations on failure. */
function createFragmentParser(content: string, blocks: Block[]): ParseFragment {
  const syntax = new SyntaxParser();
  return (text, block, offset = 0) => {
    try {
      return normalize(syntax.parse(text), text, block, offset);
    } catch (cause) {
      if (!(cause instanceof SNFParseError)) throw cause;
      let relative = offset + cause.offset;
      let position = blocks[block].start;
      const physical = blocks[block].lines.filter(line => line.type === DocumentLineType.CONTENT);
      for (const line of physical) {
        position = line.start + Math.min(relative, line.content.length);
        if (relative <= line.content.length) break;
        relative -= line.content.length + 1;
      }
      throw new SNFParseError(cause.message.replace(/ at \d+:\d+$/, ''), content, position, cause.expected);
    }
  };
}

function parseProduction(declaration: Declaration, blocks: Block[], parse: ParseFragment): Node {
  const firstBlock = declaration.blocks[0];
  const source = blocks[firstBlock].content;
  if (declaration.kind === 'STATEMENT') {
    return {
      type: NodeType.STATEMENT,
      content: declaration.names[0],
      raw: source,
      start: 0,
      end: source.length,
      sourceBlock: firstBlock,
      categories: declaration.blocks.flatMap(index => blocks[index].content.split('\n')).filter(Boolean),
    };
  }
  if (declaration.kind !== 'ONEOFIS' && declaration.kind !== 'PARTOFIS') {
    return parse(source, firstBlock);
  }

  const alternatives: Node[] = [];
  for (const index of declaration.blocks) {
    const text = blocks[index].content;
    if (declaration.kind === 'PARTOFIS') {
      alternatives.push({ ...parse(text, index), type: NodeType.GROUP });
    } else {
      let offset = 0;
      for (const row of text.split('\n')) {
        alternatives.push({ ...parse(row, index, offset), type: NodeType.GROUP });
        offset += row.length + 1;
      }
    }
  }
  const enumeration = syntheticNode(NodeType.ENUM, alternatives, firstBlock);
  return syntheticNode(NodeType.ROOT, [enumeration], firstBlock);
}

function syntheticNode(type: NodeType, children: Node[], sourceBlock: number): Node {
  return { type, content: '', raw: '', start: 0, end: 0, sourceBlock, synthetic: true, children };
}

function collectDependencies(root: Node, definitions: Map<string, Production>): string[] {
  const dependencies = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === NodeType.VARIABLE && definitions.has(node.content)) {
      dependencies.add(node.content);
    }
    // Preserve dependency discovery order; it is part of the document result.
    for (const child of node.children ?? []) pending.push(child);
  }
  return [...dependencies];
}

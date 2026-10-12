import { Block, DefinitionKind, DocumentLine, SNFDocument, TemplateDefinition, TemplateEntry } from '../type';
import { buildProductions } from './productions';
import { bindReferenceTargets, createDefinitionExpander, findRecursiveDefinitions } from './definitions';
import { createIdentityAllocator } from './identity';
import { trimBoundaryBlanks } from './layout';

/** Compile structure first, assign final metadata, then bind recursive targets. */
export function compileDocument(content: string, lines: DocumentLine[], blocks: Block[]): SNFDocument {
  const productions = buildProductions(content, blocks);
  const recursive = findRecursiveDefinitions(productions.definitions);
  const expand = createDefinitionExpander(productions.definitions, recursive);
  const identify = createIdentityAllocator();

  // Entries and definitions share counters. Keep this order stable so equivalent
  // documents retain the same IDs, including same-prefix occurrence ordinals.
  const entries: TemplateEntry[] = productions.entries.map(production => ({
    name: production.names[0],
    blocks: [...production.blocks],
    dependencies: [...production.dependencies],
    ast: identify(trimBoundaryBlanks(expand(production.tree))),
  }));
  const definitions: TemplateDefinition[] = [...new Set(productions.definitions.values())].map(
    production => ({
      kind: production.kind as DefinitionKind,
      names: [...production.names],
      blocks: [...production.blocks],
      dependencies: [...production.dependencies],
      recursive: recursive.has(production),
      ast: identify(trimBoundaryBlanks(expand(production.tree))),
    }),
  );

  bindReferenceTargets(entries, definitions);
  return { type: 'document', content, lines, blocks, entries, definitions };
}

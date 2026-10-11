import { Node, NodeType, QuoteCharacter } from '../type';

/** A sequence owns its frame; nested sequences inherit without writing back. */
export interface DefinitionScope {
  keywords: string[];
  collecting: boolean;
  quote?: QuoteCharacter;
}

export const inheritDefinitionScope = (scope: DefinitionScope, quote = scope.quote): DefinitionScope => ({
  keywords: [...scope.keywords],
  collecting: false,
  quote,
});

/** Advance only after the current node has read its incoming context. */
export const advanceDefinitionScope = (scope: DefinitionScope, node: Node): void => {
  const quote = node.quote ?? scope.quote;
  const trivia = node.type === NodeType.BLANK || node.type === NodeType.WRAP;
  if (node.type === NodeType.DEFINITION && !quote) {
    scope.keywords = scope.collecting ? [...scope.keywords, node.content] : [node.content];
    scope.collecting = true;
  } else if (!trivia || quote) scope.collecting = false;
};

/** Readable labels intentionally allow duplicate names. */
export const definitionName = (scope: DefinitionScope, type: NodeType.ENUM | NodeType.LOOP): string =>
  scope.keywords.length ? scope.keywords.join('_').toUpperCase() : type === NodeType.ENUM ? 'ENUM' : 'LOOP';

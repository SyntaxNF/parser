import { Node, NodeType, QuoteCharacter } from '../type';
import { walk } from '../walk';

const quoteCharacter = (node: Node): QuoteCharacter | undefined => {
  if (node.type === NodeType.QUOTE) return `'`;
  if (node.type === NodeType.DOUBLEQUOTE) return `"`;
  return undefined;
};

/** Removes quote delimiter nodes and annotates the enclosed nodes with their quote character. */
export const exchangeQuoteNode = (root: Node): Node => {
  return walk(root, {
    exchangeChildren: (children: Node[]): Node[] => {
      const result: Node[] = [];
      let activeQuote: QuoteCharacter | undefined;

      for (const child of children) {
        const delimiter = quoteCharacter(child);
        if (delimiter) {
          if (!activeQuote) {
            activeQuote = delimiter;
          } else if (activeQuote === delimiter) {
            activeQuote = undefined;
          } else {
            result.push({ ...child, quote: activeQuote });
          }
          continue;
        }

        result.push(activeQuote ? { ...child, quote: activeQuote } : child);
      }

      return result;
    },
  });
};

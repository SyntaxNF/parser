import { Node, NodeType } from '../type';
import { walk } from '../walk';

const ignoredSiblingTypes = new Set([NodeType.BLANK, NodeType.WRAP]);
const repeatableTypes = new Set([NodeType.ENUM, NodeType.OPTIONAL, NodeType.VARIABLE]);

/**
 * Converts postfix repetition into a logical loop node. The repeated sibling
 * becomes the loop child and the marker's original children are retained in ast.
 */
export const exchangeLoopNode = (root: Node): Node => {
  return walk(root, {
    exchangeChildren: (children: Node[]): Node[] => {
      const result: Node[] = [];

      for (const child of children) {
        if (child.type !== NodeType.LOOP) {
          result.push(child);
          continue;
        }

        let repeatedIndex = result.length - 1;
        while (repeatedIndex >= 0 && ignoredSiblingTypes.has(result[repeatedIndex].type)) {
          repeatedIndex--;
        }

        if (repeatedIndex < 0 || !repeatableTypes.has(result[repeatedIndex].type)) {
          result.push(child);
          continue;
        }

        const repeatedChildren = result.splice(repeatedIndex);
        result.push({
          ...child,
          ast: child.children ? [...child.children] : [],
          children: repeatedChildren,
        });
      }

      return result;
    },
  });
};

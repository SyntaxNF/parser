import { Node } from '../type';
import { walk } from '../walk';

/** Creates a deep structural copy of children and walker-generated ast subtrees. */
export const copyNode = (root: Node): Node => {
  return walk(root, {
    childKeys: ['children', 'ast'],
    includeRoot: true,
    exchange: (node) => ({ ...node }),
  });
};

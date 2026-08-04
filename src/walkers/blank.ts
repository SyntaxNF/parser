import { Node, NodeType } from '../type';
import { walk } from '../walk';

/** Removes every horizontal blank node from an AST. */
export const cleanBlank = (root: Node): Node => {
  return walk(root, {
    filter: (node) => node.type !== NodeType.BLANK,
  });
};

/** Removes separator blanks while retaining indentation made of multiple characters. */
export const cleanSingleBlank = (root: Node): Node => {
  return walk(root, {
    filter: (node) => node.type !== NodeType.BLANK || node.content.length > 1,
  });
};

import { Node, NodeType } from '../type';
import { walk } from '../walk';

/** Collects dotted paths for named enum/loop scopes and their variables. */
export const collectName = (root: Node): string[] => {
  const paths: string[] = [];
  const currentPath: string[] = [];

  walk(root, {
    includeRoot: true,
    exchange: (node) => {
      if ([NodeType.ENUM, NodeType.LOOP].includes(node.type) && node.name) {
        currentPath.push(node.type === NodeType.LOOP ? `${node.name}[]` : node.name);
        paths.push(currentPath.join('.'));
      }

      if (node.type === NodeType.VARIABLE) {
        paths.push([...currentPath, node.content].join('.'));
      }
    },
    back: (node) => {
      if ([NodeType.ENUM, NodeType.LOOP].includes(node.type) && node.name) {
        currentPath.pop();
      }
    },
  });

  return paths;
};

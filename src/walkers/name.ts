import { ExchangeType, Node, NodeType } from '../type';
import { walk } from '../walk';

const ignoredSiblingTypes = new Set([NodeType.BLANK, NodeType.WRAP]);

const isNamedContent = (content: string): boolean => {
  return /^\w+$/.test(content);
};

const intrinsicEnumName = (node: Node): string | undefined => {
  const firstGroup = node.children?.find((child) => child.type === NodeType.GROUP);
  const firstDefinition = firstGroup?.children?.find(
    (child) => child.type === NodeType.DEFINITION && isNamedContent(child.content),
  );
  const firstVariable = firstGroup?.children?.find((child) => child.type === NodeType.VARIABLE);
  const firstEnum = firstGroup?.children?.find((child) => child.type === NodeType.ENUM && child.name);

  return firstDefinition?.content ?? firstVariable?.content ?? firstEnum?.name;
};

const previousSignificantSibling = (children: Node[], index: number): Node | undefined => {
  for (let current = index - 1; current >= 0; current--) {
    if (!ignoredSiblingTypes.has(children[current].type)) return children[current];
  }
  return undefined;
};

/** Adds deterministic heuristic names to unnamed enum nodes. */
export const addEnumName = (root: Node): Node => {
  return walk(root, {
    includeRoot: true,
    exchangeType: ExchangeType.AFTER,
    exchangeChildren: (children: Node[]): Node[] => {
      const existingNames = new Set(children.flatMap((child) => (child.name ? [child.name] : [])));

      return children.map((child, index) => {
        if (child.type !== NodeType.ENUM || child.name) return child;

        const previous = previousSignificantSibling(children, index);
        const adjacentName = previous?.type === NodeType.DEFINITION ? previous.content : undefined;
        const name = adjacentName && !existingNames.has(adjacentName) ? adjacentName : intrinsicEnumName(child);
        if (!name) return child;

        existingNames.add(name);
        return { ...child, name };
      });
    },
    exchange: (node, _parent, context) => {
      if (context.parent || node.type !== NodeType.ENUM || node.name) return node;
      const name = intrinsicEnumName(node);
      return name ? { ...node, name } : node;
    },
  });
};

/** Adds pluralized heuristic names to postfix loop nodes. */
export const addLoopName = (root: Node): Node => {
  return walk(root, {
    exchangeChildren: (children: Node[]): Node[] => {
      return children.map((child, index) => {
        if (child.type !== NodeType.LOOP || child.name) return child;

        for (let current = index - 1; current >= 0; current--) {
          const previous = children[current];
          if (![NodeType.DEFINITION, NodeType.ENUM, NodeType.VARIABLE].includes(previous.type)) continue;

          const baseName = previous.name ?? previous.content;
          return baseName ? { ...child, name: `${baseName}s` } : child;
        }

        return child;
      });
    },
  });
};

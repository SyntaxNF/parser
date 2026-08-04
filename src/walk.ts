import { Block, ExchangeType, Node, SNFDocument } from './type';

export type WalkChildKey = 'children' | 'ast';

export interface WalkContext {
  /** The actual parent, unlike the compatibility callback argument used for root. */
  parent?: Node;
  /** Zero-based index in the current child collection. */
  index: number;
  /** The child collection before its members are visited. */
  siblings: readonly Node[];
  /** Ancestors from root to parent. */
  ancestors: readonly Node[];
  /** The parent property through which this node was reached. */
  key?: WalkChildKey;
}

export interface WalkChildrenContext {
  /** Ancestors from root to the owner of this child collection. */
  ancestors: readonly Node[];
  /** The parent property containing this child collection. */
  key: WalkChildKey;
}

export interface WalkOption {
  /** Also applies exchange/back to root. Root itself is never filtered out. */
  includeRoot?: boolean;
  /** Controls whether exchange runs before children, after children, or both. */
  exchangeType?: ExchangeType;
  /** Child properties to traverse. Defaults to children only. */
  childKeys?: WalkChildKey[];
  /**
   * Transforms one node. Returning void retains the current node. Root is only
   * included when includeRoot is true.
   */
  exchange?: (node: Node, parent: Node, context: WalkContext) => Node | void;
  /**
   * Runs after members have been visited and filtered, enabling sibling reorganization.
   */
  exchangeChildren?: (children: Node[], parent: Node, context: WalkChildrenContext) => Node[] | void;
  /**
   * Runs after a descendant and its subtree have been visited. Returning false
   * removes that node from its parent collection. Root is never filtered.
   */
  filter?: (node: Node, parent: Node, context: WalkContext) => boolean;
  /**
   * Runs once when leaving a node, after its child collections and AFTER
   * exchange have completed. Root is only included when includeRoot is true.
   */
  back?: (node: Node, parent: Node, context: WalkContext) => void;
}

export type NodeWalk = (node: Node) => Node;
export type BlockReducer<T> = (result: T, block: Block, index: number, blocks: readonly Block[]) => T;
export type BlockExchange = (block: Block, index: number, blocks: readonly Block[]) => Block | void;

interface ChildCollection {
  array: boolean;
  nodes: Node[];
}

const childCollection = (node: Node, key: WalkChildKey): ChildCollection | undefined => {
  if (key === 'children') {
    return node.children ? { array: true, nodes: node.children } : undefined;
  }

  if (Array.isArray(node.ast)) return { array: true, nodes: node.ast };
  if (node.ast) return { array: false, nodes: [node.ast] };
  return undefined;
};

const setChildCollection = (node: Node, key: WalkChildKey, collection: ChildCollection, nodes: Node[]): Node => {
  if (key === 'children') return { ...node, children: nodes };
  return { ...node, ast: collection.array ? nodes : nodes[0] };
};

/**
 * Walks an AST without mutating the input. Existing two-argument callbacks stay
 * compatible; the third argument provides stable traversal context.
 */
export const walk = (root: Node, option: WalkOption): Node => {
  const childKeys = option.childKeys ?? ['children'];
  const exchangeType = option.exchangeType ?? ExchangeType.BEFORE;

  const visit = (node: Node, context: WalkContext, applyCallbacks: boolean): Node => {
    let current = node;
    const compatibilityParent = context.parent ?? node;

    if (applyCallbacks && option.exchange && [ExchangeType.BEFORE, ExchangeType.BOTH].includes(exchangeType)) {
      current = option.exchange(current, compatibilityParent, context) ?? current;
    }

    for (const key of childKeys) {
      const collection = childCollection(current, key);
      if (!collection) continue;

      const ancestors = [...context.ancestors, current];
      const visited = collection.nodes.flatMap((child, index) => {
        const childContext: WalkContext = {
          parent: current,
          index,
          siblings: collection.nodes,
          ancestors,
          key,
        };
        const result = visit(child, childContext, true);
        return option.filter?.(result, current, childContext) === false ? [] : [result];
      });
      const exchanged = option.exchangeChildren?.(visited, current, { ancestors, key }) ?? visited;
      current = setChildCollection(current, key, collection, exchanged);
    }

    if (applyCallbacks && option.exchange && [ExchangeType.AFTER, ExchangeType.BOTH].includes(exchangeType)) {
      current = option.exchange(current, compatibilityParent, context) ?? current;
    }

    if (applyCallbacks) option.back?.(current, compatibilityParent, context);
    return current;
  };

  return visit(
    root,
    {
      index: 0,
      siblings: [root],
      ancestors: [],
    },
    option.includeRoot ?? false,
  );
};

export const walkBlocks = (blocks: Block[], ...walks: NodeWalk[]): Block[] => {
  return blocks.map((block) => {
    let ast = block.ast;
    for (const each of walks) {
      ast = each(ast);
    }

    return {
      ...block,
      ast,
    };
  });
};

export const walkDocument = (document: SNFDocument, ...walks: NodeWalk[]): SNFDocument => {
  return {
    ...document,
    blocks: walkBlocks(document.blocks, ...walks),
  };
};

export const exchangeBlocks = (blocks: Block[], exchange: BlockExchange): Block[] => {
  return blocks.map((block, index) => exchange(block, index, blocks) ?? block);
};

export const reduceBlocks = <T>(blocks: Block[], reducer: BlockReducer<T>, initialValue: T): T => {
  return blocks.reduce((result, block, index) => reducer(result, block, index, blocks), initialValue);
};

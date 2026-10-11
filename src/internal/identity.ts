import { Node, NodeType, QuoteCharacter } from '../type';
import {
  advanceDefinitionScope,
  definitionName,
  DefinitionScope,
  inheritDefinitionScope,
} from './definition-context';
import { hash128 } from './hash';
import { collectLocalFeatures, LocalFeature } from './boundary-identity';

export const UID_VERSION = 'UID_V1';

/** Append-only registry: never renumber or reuse a retired code. */
export const UID_TYPE_CODES: Readonly<Record<NodeType, string>> = Object.freeze({
  [NodeType.ROOT]: 'RO00',
  [NodeType.COLLECTION]: 'CO00',
  [NodeType.LOOP]: 'LO00',
  [NodeType.OPTIONAL]: 'OP00',
  [NodeType.ENUM]: 'EN00',
  [NodeType.GROUP]: 'GR00',
  [NodeType.SPLIT]: 'SP00',
  [NodeType.REPEAT]: 'RE00',
  [NodeType.DEFINITION]: 'DE00',
  [NodeType.VARIABLE]: 'VA00',
  [NodeType.NUMBER]: 'NU00',
  [NodeType.BLANK]: 'BL00',
  [NodeType.WRAP]: 'WR00',
  [NodeType.QUOTED]: 'QT00',
  [NodeType.REFERENCE]: 'RF00',
  [NodeType.STATEMENT]: 'ST00',
  [NodeType.QUOTE]: 'QU00',
  [NodeType.DOUBLEQUOTE]: 'DQ00',
  [NodeType.OTHER]: 'OT00',
});

type Edge = 'root' | 'children';
interface Task {
  node: Node;
  depth: number;
  parentHash: string | null;
  edge: Edge;
  scope: DefinitionScope;
  assign: (node: Node) => void;
}
interface NodeDescription {
  local: unknown;
  name?: string;
}

const fixed = new Set([NodeType.DEFINITION, NodeType.NUMBER, NodeType.OTHER]);
const contextual = new Set([
  NodeType.COLLECTION,
  NodeType.VARIABLE,
  NodeType.ENUM,
  NodeType.LOOP,
  NodeType.REFERENCE,
  NodeType.STATEMENT,
]);
const trivia = new Set([NodeType.BLANK, NodeType.WRAP]);

const hex = (value: number, label: string) => {
  if (value > 0xffff) throw new RangeError(`SNF uid ${label} overflow: ${value} exceeds FFFF`);
  return value.toString(16).toUpperCase().padStart(4, '0');
};

/** Derive identity and display metadata from the same incoming definition scope. */
function describeNode(
  node: Node, scope: DefinitionScope, feature: LocalFeature | undefined, quote?: QuoteCharacter,
): NodeDescription {
  let local: unknown = null;
  let name: string | undefined;
  if (fixed.has(node.type)) {
    local = [UID_TYPE_CODES[node.type], node.content];
  } else if (contextual.has(node.type) && scope.keywords.length) {
    local = ['DEFINITION_CONTEXT', [...scope.keywords]];
  } else if (feature) {
    local = feature.code;
    if (node.type === NodeType.OPTIONAL) {
      const descriptor = node.children?.find(child => fixed.has(child.type));
      name = descriptor?.content.toUpperCase() || 'OPTIONAL';
    }
  } else if (
    [NodeType.SPLIT, NodeType.REPEAT, NodeType.QUOTE, NodeType.DOUBLEQUOTE].includes(node.type) ||
    (trivia.has(node.type) && quote)
  ) {
    local = [UID_TYPE_CODES[node.type], node.content];
  }

  if ([NodeType.VARIABLE, NodeType.REFERENCE, NodeType.STATEMENT].includes(node.type)) {
    name = node.content;
  } else if (node.type === NodeType.ENUM || node.type === NodeType.LOOP) {
    name = definitionName(scope, node.type);
  }
  return { local, name };
}

// Internal hash seam for collision regression tests; not part of package exports.
export function createUidAllocator(hash: (input: string) => string): (root: Node) => Node {
  const counts = new Map<string, number>();
  const paths = new Map<string, string>();
  const hashes = new Map<string, string>();
  return root => {
    // Phase 1 has no UID or definition-scope dependencies. Phase 2 below is preorder.
    const features = collectLocalFeatures([root]);
    const previousCounts = new Map<string, number | undefined>();
    const addedPaths: string[] = [];
    let result: Node;
    const tasks: Task[] = [
      {
        node: root,
        depth: 0,
        parentHash: null,
        edge: 'root',
        scope: { keywords: [], collecting: false },
        assign: node => {
          result = node;
        },
      },
    ];
    try {
      while (tasks.length) {
        const { node, depth, parentHash, edge, scope, assign } = tasks.pop()!;
        const depthCode = hex(depth, 'depth');
        if (!Object.hasOwn(UID_TYPE_CODES, node.type))
          throw new Error(`Unknown SNF uid node type: ${node.type}`);
        const code = UID_TYPE_CODES[node.type];
        const quote = node.quote ?? scope.quote;
        const { local, name } = describeNode(node, scope, features.get(node), quote);
        // Parent digest commits to all ancestor segments, never their ordinals.
        // JSON arrays preserve token boundaries; UTF-8 and hash case are fixed.
        const path = JSON.stringify([
          UID_VERSION,
          parentHash,
          edge,
          code,
          local,
          quote ?? null,
          node.type === NodeType.LOOP ? node.separator : null,
          node.type === NodeType.STATEMENT ? node.categories : null,
        ]);
        let digest = hashes.get(path);
        if (!digest) {
          digest = hash(path);
          if (!/^[0-9A-F]{32}$/.test(digest))
            throw new Error('Invalid SNF uid hash: expected 32 uppercase hex digits');
          if (paths.has(digest) && paths.get(digest) !== path)
            throw new Error(`SNF uid hash collision: ${digest}`);
          paths.set(digest, path);
          hashes.set(path, digest);
          addedPaths.push(path);
        }
        const prefix = `${code}-${depthCode}-${digest}`;
        const ordinal = counts.get(prefix) ?? 0;
        const uid = `${prefix}-${hex(ordinal, 'ordinal')}`;
        if (!previousCounts.has(prefix)) previousCounts.set(prefix, counts.get(prefix));
        counts.set(prefix, ordinal + 1);
        const copy: Node = { ...node, uid }; // Recompute even if the input already has a uid.
        if (!node.name && name !== undefined) copy.name = name;
        assign(copy);

        advanceDefinitionScope(scope, node);
        if (node.children) {
          const children: Node[] = [];
          copy.children = children;
          const frame = inheritDefinitionScope(scope, quote);
          for (let index = node.children.length - 1; index >= 0; index--) {
            tasks.push({
              node: node.children[index],
              depth: depth + 1,
              parentHash: digest,
              edge: 'children',
              scope: frame,
              assign: child => {
                children[index] = child;
              },
            });
          }
        }
      }
      return result!;
    } catch (error) {
      // A failed tree must not consume IDs in a reused document allocator.
      for (const [prefix, count] of previousCounts) {
        if (count === undefined) counts.delete(prefix);
        else counts.set(prefix, count);
      }
      for (const path of addedPaths) {
        paths.delete(hashes.get(path)!);
        hashes.delete(path);
      }
      throw error;
    }
  };
}

/** Assigns UIDs and missing dynamic-node names; one allocator per document, fresh context per root. */
export const createIdentityAllocator = (): ((root: Node) => Node) => createUidAllocator(hash128);

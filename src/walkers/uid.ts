import { Node, NodeType, QuoteCharacter, SNFDocument } from '../type';
import { hash128 } from './uid-hash';

/** Append-only registry: never renumber or reuse a retired code. */
export const UID_TYPE_CODES: Readonly<Record<NodeType, string>> = Object.freeze({
  [NodeType.ROOT]: 'RO00', [NodeType.COLLECTION]: 'CO00', [NodeType.LOOP]: 'LO00',
  [NodeType.OPTIONAL]: 'OP00', [NodeType.ENUM]: 'EN00', [NodeType.GROUP]: 'GR00',
  [NodeType.SPLIT]: 'SP00', [NodeType.REPEAT]: 'RE00', [NodeType.DEFINITION]: 'DE00',
  [NodeType.VARIABLE]: 'VA00', [NodeType.NUMBER]: 'NU00', [NodeType.BLANK]: 'BL00',
  [NodeType.WRAP]: 'WR00', [NodeType.QUOTE]: 'QU00', [NodeType.DOUBLEQUOTE]: 'DQ00', [NodeType.OTHER]: 'OT00',
});
export const UID_VERSION = 'snf-uid-v1';
const fixed = new Set([NodeType.DEFINITION, NodeType.NUMBER, NodeType.OTHER]);
const contextual = new Set([NodeType.VARIABLE, NodeType.ENUM, NodeType.LOOP]);
const trivia = new Set([NodeType.BLANK, NodeType.WRAP]);
interface Scope { keywords: string[]; collecting: boolean; quote?: QuoteCharacter }
type Edge = 'root' | 'children' | 'ast';
interface Task {
  node: Node; depth: number; parentHash: string | null; edge: Edge; scope: Scope;
  assign: (node: Node) => void;
}
const hex = (value: number, label: string) => {
  if (value > 0xffff) throw new RangeError(`SNF uid ${label} overflow: ${value} exceeds FFFF`);
  return value.toString(16).toUpperCase().padStart(4, '0');
};
const inherit = (scope: Scope, quote = scope.quote): Scope => ({ keywords: [...scope.keywords], collecting: false, quote });

// Internal hash seam for collision regression tests; not part of package exports.
export function createUidAllocator(hash: (input: string) => string): (root: Node) => Node {
  const counts = new Map<string, number>();
  const paths = new Map<string, string>();
  const hashes = new Map<string, string>();
  return root => {
    const previousCounts = new Map<string, number | undefined>();
    const addedPaths: string[] = [];
    let result: Node;
    const tasks: Task[] = [{ node: root, depth: 0, parentHash: null, edge: 'root', scope: { keywords: [], collecting: false }, assign: node => { result = node; } }];
    try {
      while (tasks.length) {
        const { node, depth, parentHash, edge, scope, assign } = tasks.pop()!;
        const depthCode = hex(depth, 'depth');
        if (!Object.hasOwn(UID_TYPE_CODES, node.type)) throw new Error(`Unknown SNF uid node type: ${node.type}`);
        const code = UID_TYPE_CODES[node.type];
        const quote = node.quote ?? scope.quote;
        let local: unknown = null;
        if (fixed.has(node.type)) local = [code, node.content];
        else if (contextual.has(node.type) && scope.keywords.length) local = ['DEFINITION_CONTEXT', [...scope.keywords]];
        else if (node.type === NodeType.OPTIONAL) {
          const first = node.children?.find(child => fixed.has(child.type));
          if (first) local = [UID_TYPE_CODES[first.type], first.content];
        } else if ([NodeType.SPLIT, NodeType.REPEAT, NodeType.QUOTE, NodeType.DOUBLEQUOTE].includes(node.type)
          || (trivia.has(node.type) && quote)) local = [code, node.content];
        // Parent digest commits to all ancestor segments, never their ordinals.
        // JSON arrays preserve token boundaries; UTF-8 and hash case are fixed.
        const path = JSON.stringify([UID_VERSION, parentHash, edge, code, local, quote ?? null]);
        let digest = hashes.get(path);
        if (!digest) {
          digest = hash(path);
          if (!/^[0-9A-F]{32}$/.test(digest)) throw new Error('Invalid SNF uid hash: expected 32 uppercase hex digits');
          if (paths.has(digest) && paths.get(digest) !== path) throw new Error(`SNF uid hash collision: ${digest}`);
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
        assign(copy);

        if (node.type === NodeType.DEFINITION && !quote) {
          scope.keywords = scope.collecting ? [...scope.keywords, node.content] : [node.content];
          scope.collecting = true;
        } else if (!trivia.has(node.type) || quote) scope.collecting = false;
        // Raw quote nodes and Quote Walker metadata both preserve quoted identity.
        if (!node.quote && [NodeType.QUOTE, NodeType.DOUBLEQUOTE].includes(node.type)) {
          const delimiter = node.type === NodeType.QUOTE ? "'" : '"';
          if (!scope.quote) scope.quote = delimiter;
          else if (scope.quote === delimiter) scope.quote = undefined;
        }
        const enqueue = (nodes: Node[], key: 'children' | 'ast', set: (node: Node, index: number) => void) => {
          const frame = inherit(scope, quote);
          for (let i = nodes.length - 1; i >= 0; i--) tasks.push({ node: nodes[i], depth: depth + 1, parentHash: digest!, edge: key, scope: frame, assign: value => set(value, i) });
        };
        // LIFO gives preorder: node, children, ast. Each collection owns a frame;
        // each GROUP's children inherit independently, never a sibling's keywords.
        if (node.ast) {
          if (Array.isArray(node.ast)) {
            const target: Node[] = [];
            copy.ast = target;
            enqueue(node.ast, 'ast', (value, i) => { target[i] = value; });
          } else {
            enqueue([node.ast], 'ast', value => { copy.ast = value; });
          }
        }
        if (node.children) {
          const target: Node[] = [];
          copy.children = target;
          enqueue(node.children, 'children', (value, i) => { target[i] = value; });
        }
      }
      return result!;
    } catch (error) {
      // A failed block must not consume IDs in a reused document allocator.
      for (const [prefix, count] of previousCounts) {
        if (count === undefined) counts.delete(prefix); else counts.set(prefix, count);
      }
      for (const path of addedPaths) { paths.delete(hashes.get(path)!); hashes.delete(path); }
      throw error;
    }
  };
}

/** One allocator per document; every root call resets the DEFINITION scope. */
export const createAddUid = (): ((root: Node) => Node) => createUidAllocator(hash128);

/** Assigns stable IDs to an already-transformed document using a fresh session. */
export function addDocumentUid(document: SNFDocument): SNFDocument {
  const addUid = createAddUid();
  return { ...document, blocks: document.blocks.map(block => ({ ...block, ast: addUid(block.ast) })) };
}

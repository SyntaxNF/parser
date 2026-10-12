import { Node, NodeType, QuoteCharacter } from '../type';
import { shortCode } from './hash';

const initials = new Map(Object.entries(NodeType).map(([name, type]) => [type, name[0]]));
const boundaries = new Set([NodeType.QUOTED, NodeType.OPTIONAL, NodeType.GROUP]);
type Token = ['Q', QuoteCharacter, string] | ['D' | 'N' | 'T', string];

export interface LocalFeature {
  /** Ordered direct-child features before this node's four-digit compression. */
  signature: string;
  code: string;
}

/** Read one child level only. QUOTED contributes its already-computed local code. */
function describeChildren(node: Node, features: Map<Node, LocalFeature>): Token[] {
  const tokens: Token[] = [];
  for (const child of node.children ?? []) {
    if (child.type === NodeType.BLANK || child.type === NodeType.WRAP) continue;
    if (child.type === NodeType.DEFINITION) {
      tokens.push(['D', child.content]);
    } else if (child.type === NodeType.NUMBER) {
      tokens.push(['N', child.content]);
    } else if (child.type === NodeType.QUOTED) {
      tokens.push(['Q', child.quote!, features.get(child)!.code]);
    } else {
      const initial = initials.get(child.type);
      if (!initial) throw new Error(`Unknown SNF uid node type: ${child.type}`);
      tokens.push(['T', initial]);
    }
  }
  return tokens;
}

/** Iterative postorder DFS: finish child features before describing the parent. No UID dependencies. */
export function collectLocalFeatures(roots: readonly Node[]): Map<Node, LocalFeature> {
  const features = new Map<Node, LocalFeature>();
  const entered = new Set<Node>();
  const tasks: { node: Node; exit: boolean }[] = roots
    .slice().reverse().map(node => ({ node, exit: false }));
  while (tasks.length) {
    const { node, exit } = tasks.pop()!;
    if (exit) {
      if (boundaries.has(node.type)) {
        const signature = JSON.stringify(describeChildren(node, features));
        features.set(node, { signature, code: shortCode(signature) });
      }
      continue;
    }
    if (entered.has(node)) continue;
    entered.add(node);
    tasks.push({ node, exit: true });
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
      tasks.push({ node: node.children![index], exit: false });
  }
  return features;
}

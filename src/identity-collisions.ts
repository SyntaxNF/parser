import { Node } from './type';
import { collectLocalFeatures } from './internal/boundary-identity';

export interface IdentityCollision {
  /** Different full signatures compressed to one prefix, or already identical features. */
  kind: 'short-hash' | 'same-signature';
  /** Type, depth and functional-path digest; excludes the ordinal. */
  prefix: string;
  occurrences: (Pick<Node, 'uid' | 'sourceBlock' | 'start' | 'end' | 'raw'> & {
    /** Ordered direct-child signature before this node's compression; child QUOTED uses its code. */
    fullSignature: string;
  })[];
}

/** Inspect final roots from ONE parse session. Reports order-sensitive QUOTED/OPTIONAL/GROUP identities. */
export function findIdentityCollisions(roots: Node | readonly Node[]): IdentityCollision[] {
  const rootNodes: readonly Node[] = Array.isArray(roots) ? roots : [roots];
  const features = collectLocalFeatures(rootNodes);
  const buckets = new Map<string, IdentityCollision['occurrences']>();
  const visited = new Set<Node>();
  const uids = new Set<string>();
  const pending = rootNodes.slice().reverse();
  while (pending.length) {
    const node = pending.pop()!;
    // Repeated root references must not manufacture collisions. Different objects with
    // one UID are invalid input, commonly roots from independent parse sessions.
    if (visited.has(node)) continue;
    visited.add(node);
    if (!node.uid || !/^[A-Z]{2}[0-9A-F]{2}-[0-9A-F]{4}-[0-9A-F]{32}-[0-9A-F]{4}$/.test(node.uid))
      throw new Error('Identity collision detection requires a final AST with assigned UIDs');
    if (uids.has(node.uid))
      throw new Error(`Identity collision detection requires unique UIDs from one parse session: ${node.uid}`);
    uids.add(node.uid);
    const feature = features.get(node);
    if (feature) {
      const prefix = node.uid.slice(0, -5);
      const occurrences = buckets.get(prefix) ?? [];
      const { uid, sourceBlock, start, end, raw } = node;
      occurrences.push({
        uid, sourceBlock, start, end, raw,
        fullSignature: feature.signature,
      });
      buckets.set(prefix, occurrences);
    }
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
      pending.push(node.children![index]);
  }
  return [...buckets]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([prefix, occurrences]) => ({
      kind: new Set(occurrences.map(n => n.fullSignature)).size > 1
        ? 'short-hash' : 'same-signature',
      prefix,
      occurrences,
    }));
}

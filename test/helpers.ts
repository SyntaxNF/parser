import { Node } from '../src/type';
export function nodes(root: Node): Node[] {
  const result: Node[] = [],
    pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...(node.children ?? []).slice().reverse());
  }
  return result;
}

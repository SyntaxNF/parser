import { Node, NodeType, SimpleNode, SimpleSNFDocument, SNFDocument } from '../type';

/** Strip source information after UID assignment and recursive target resolution. */
export function simpleNode(root: Node): SimpleNode {
  const copy = (node: Node): SimpleNode => {
    const { raw, start, end, sourceBlock, synthetic, content, children, ...runtime } = node;
    const result: SimpleNode = { ...runtime };
    // COLLECTION content is the binding/input key, not the expanded template body.
    if (!children || node.type === NodeType.COLLECTION) result.content = content;
    if (node.binding) result.binding = { ...node.binding };
    if (node.categories) result.categories = [...node.categories];
    if (children) result.children = new Array(children.length);
    return result;
  };
  const result = copy(root);
  const pending: { source: Node; target: SimpleNode }[] = [{ source: root, target: result }];
  while (pending.length) {
    const { source, target } = pending.pop()!;
    for (let index = 0; index < (source.children?.length ?? 0); index++) {
      const child = source.children![index];
      const converted = copy(child);
      target.children![index] = converted;
      pending.push({ source: child, target: converted });
    }
  }
  return result;
}

export function simpleDocument(document: SNFDocument): SimpleSNFDocument {
  return {
    type: document.type,
    entries: document.entries.map(({ blocks, ast, ...entry }) => ({
      ...entry,
      dependencies: [...entry.dependencies],
      ast: simpleNode(ast),
    })),
    definitions: document.definitions.map(({ blocks, ast, ...definition }) => ({
      ...definition,
      names: [...definition.names],
      dependencies: [...definition.dependencies],
      ast: simpleNode(ast),
    })),
  };
}

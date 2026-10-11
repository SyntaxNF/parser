import { Node, NodeType, DefinitionKind, TemplateDefinition, TemplateEntry } from '../type';
import { Production } from './productions';

/** Identify exactly the definitions in recursive strongly connected components. */
export function findRecursiveDefinitions(definitions: Map<string, Production>): Set<Production> {
  let nextIndex = 0;
  const indices = new Map<Production, number>();
  const low = new Map<Production, number>();
  const stack: Production[] = [];
  const onStack = new Set<Production>();
  const recursive = new Set<Production>();
  interface SearchFrame {
    production: Production;
    targets: Production[];
    next: number;
  }
  const search: SearchFrame[] = [];
  const enter = (production: Production) => {
    indices.set(production, nextIndex);
    low.set(production, nextIndex++);
    stack.push(production);
    onStack.add(production);
    search.push({
      production,
      targets: production.dependencies.map(name => definitions.get(name)!),
      next: 0,
    });
  };
  // An explicit DFS stack also handles large recursive grammars without using
  // the JavaScript call stack once per definition.
  for (const production of new Set(definitions.values())) {
    if (indices.has(production)) continue;
    enter(production);
    while (search.length) {
      const frame = search.at(-1)!;
      const current = frame.production;
      if (frame.next < frame.targets.length) {
        const target = frame.targets[frame.next++];
        if (!indices.has(target)) enter(target);
        else if (onStack.has(target)) low.set(current, Math.min(low.get(current)!, indices.get(target)!));
        continue;
      }
      if (low.get(current) === indices.get(current)) {
        const component: Production[] = [];
        let member: Production;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== current);
        if (component.length > 1 || frame.targets.includes(current)) {
          component.forEach(value => recursive.add(value));
        }
      }
      search.pop();
      const parent = search.at(-1)?.production;
      if (parent) low.set(parent, Math.min(low.get(parent)!, low.get(current)!));
    }
  }
  return recursive;
}

/** One expansion budget per document, shared by entries and canonical definitions. */
export function createDefinitionExpander(
  definitions: Map<string, Production>,
  recursive: Set<Production>,
): (root: Node) => Node {
  let expandedNodes = 0;
  return (root: Node): Node => {
    let result: Node;
    const pending: Array<{ node: Node; assign: (node: Node) => void }> = [
      {
        node: root,
        assign: node => {
          result = node;
        },
      },
    ];
    while (pending.length) {
      const { node, assign } = pending.pop()!;
      if (++expandedNodes > 1_000_000) throw new RangeError('Compiled template exceeds 1000000 nodes');
      let copy: Node = { ...node };
      let children = node.children;
      if (node.type === NodeType.VARIABLE && definitions.has(node.content)) {
        const definition = definitions.get(node.content)!;
        const binding = { name: node.content, kind: definition.kind as DefinitionKind };
        if (definition.kind === 'STATEMENT') {
          copy = { ...node, type: NodeType.STATEMENT, binding, categories: [...definition.tree.categories!] };
        } else if (recursive.has(definition)) {
          copy = { ...node, type: NodeType.REFERENCE, binding, target: node.content };
        } else {
          copy = { ...node, type: NodeType.COLLECTION, binding };
          children = definition.tree.children!;
        }
      }
      assign(copy);
      if (children) {
        const output: Node[] = [];
        copy.children = output;
        for (let i = children.length - 1; i >= 0; i--) {
          pending.push({
            node: children[i],
            assign: value => {
              output[i] = value;
            },
          });
        }
      }
    }
    return result!;
  };
}

/** Resolve recursive references only after every definition root has its final UID. */
export function bindReferenceTargets(entries: TemplateEntry[], definitions: TemplateDefinition[]): void {
  const targets = new Map(
    definitions.flatMap(definition => definition.names.map(name => [name, definition.ast.uid!] as const)),
  );

  for (const item of [...entries, ...definitions]) {
    const pending = [item.ast];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === NodeType.REFERENCE) node.target = targets.get(node.target!)!;
      for (const child of node.children ?? []) pending.push(child);
    }
  }
}

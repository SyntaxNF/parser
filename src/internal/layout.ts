import { Node, NodeType as T } from '../type';

const trivia = (node: Node) => node.type === T.BLANK || node.type === T.WRAP;
const layoutOnly = new WeakSet<Node>();
const leadingCache = new WeakMap<Node, Set<Node>>();
const columns = (text: string): number => {
  let width = 0;
  for (const char of text) width = char === '\t' ? width + 4 - width % 4 : width + 1;
  return width;
};

interface Line {
  start: number;
  end: number;
  prefix: string;
  width: number;
  indent: number;
  pure: boolean;
  opening: boolean;
  real: boolean;
  literal: boolean;
  firstOutput: number;
}

/** Four-column layout units. Source spans and literal quote contents remain untouched. */
export function normalizeIndentation(root: Node, source: string, offset: number): Node {
  const lines: Line[] = [];
  const lineAt = new Uint32Array(source.length + 1);
  const grammar = new Uint8Array(source.length);
  for (let start = 0; start < source.length || !lines.length;) {
    let end = start;
    while (end < source.length && !/[\r\n]/.test(source[end])) end++;
    let next = end;
    if (source[next] === '\r' && source[next + 1] === '\n') next += 2;
    else if (next < source.length) next++;
    const prefix = /^[ \t]*/.exec(source.slice(start, end))![0];
    const width = columns(prefix);
    lines.push({ start, end, prefix, width, indent: width, pure: false, opening: false, real: false, literal: false, firstOutput: end });
    lineAt.fill(lines.length - 1, start, next);
    if (next === start || next >= source.length) break;
    start = next;
  }
  lineAt[source.length] = lines.length - 1;
  const row = (node: Node) => lineAt[Math.max(0, node.start - offset)];
  const scopes: { first: number; last: number }[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const start = node.start - offset, end = node.end - offset;
    if (node.type === T.QUOTED) {
      for (let index = lineAt[Math.max(0, start)] + 1; index <= lineAt[Math.max(0, end - 1)]; index++)
        lines[index].literal = true;
      continue;
    }
    if ((node.type === T.OPTIONAL || node.type === T.ENUM) && !node.synthetic) {
      grammar[start] = grammar[end - 1] = 1;
      const first = lineAt[start], last = lineAt[end - 1];
      scopes.push({ first, last });
      lines[first].opening = true;
      if (node.type === T.ENUM) {
        // GROUP spans stop at the branch separator; escaped pipes are OTHER leaves.
        for (const group of node.children?.slice(0, -1) ?? []) grammar[group.end - offset] = 1;
      }
    }
    if (node.type === T.LOOP && node.children?.length)
      grammar.fill(1, node.children[0].end - offset, end);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) pending.push(node.children![index]);
  }
  for (const line of lines) {
    let syntax = false;
    for (let index = line.start + line.prefix.length; index < line.end; index++) {
      if (/[ \t]/.test(source[index])) continue;
      if (grammar[index]) syntax = true;
      else {
        if (!line.real) line.firstOutput = index;
        line.real = true;
      }
    }
    line.pure = syntax && !line.real && !line.literal;
  }
  const prefixes = lines.filter(line => !line.literal && source.slice(line.start, line.end).trim()).map(line => line.prefix);
  let common = prefixes[0] ?? '';
  for (const prefix of prefixes) {
    let length = 0;
    while (length < common.length && common[length] === prefix[length]) length++;
    common = common.slice(0, length);
  }
  const base = columns(common);
  // Multiple delimiters on one physical line introduce just one layout frame.
  const frames = new Map<number, { last: number; amount: number }>();
  for (const scope of scopes) {
    if (!lines[scope.first].pure || scope.last <= scope.first) continue;
    const inside = lines.slice(scope.first + 1, scope.last).filter(line => !line.literal && (line.real || line.opening));
    if (!inside.length) continue;
    const amount = Math.max(0, inside.reduce((width, line) => Math.min(width, line.width), Infinity) - lines[scope.first].width);
    const previous = frames.get(scope.first);
    frames.set(scope.first, { last: Math.max(previous?.last ?? 0, scope.last), amount: Math.max(previous?.amount ?? 0, amount) });
  }
  const changes = new Int32Array(lines.length + 1);
  for (const [first, frame] of frames) {
    changes[first + 1] += frame.amount;
    changes[frame.last] -= frame.amount;
  }
  let reduction = 0;
  for (let index = 0; index < lines.length; index++) {
    reduction += changes[index];
    lines[index].indent = Math.max(0, lines[index].width - base - reduction);
  }
  const laterReal = new Array<boolean>(lines.length).fill(false);
  const laterPure = new Array<boolean>(lines.length).fill(false);
  for (let index = lines.length - 2; index >= 0; index--) {
    laterReal[index] = lines[index + 1].real || laterReal[index + 1];
    laterPure[index] = lines[index + 1].pure || laterPure[index + 1];
  }
  const synthetic = (type: T, at: Node, content: string, indent?: number): Node => ({
    type, content, raw: '', start: at.start, end: at.start,
    sourceBlock: at.sourceBlock, synthetic: true,
    ...(indent === undefined ? {} : { indentLevel: indent / 4 }),
  });
  const suffixes = new Map<Node, Node[]>();
  const tasks: { node: Node; quoted: boolean; exit: boolean }[] = [{ node: root, quoted: false, exit: false }];
  while (tasks.length) {
    const { node, quoted, exit } = tasks.pop()!;
    if (!exit) {
      if (!quoted) {
        const line = lines[row(node)];
        const start = node.start - offset;
        if (node.type === T.BLANK && start === line.start) {
          node.indentLevel = line.indent / 4;
          if (line.pure) { node.content = ''; layoutOnly.add(node); }
          else if (line.indent !== line.width) node.content = ' '.repeat(line.indent);
        } else if (node.type === T.BLANK && start < line.firstOutput) {
          // Inline padding around non-emitting delimiters is not extra line indentation.
          node.content = '';
        } else if (!trivia(node)) node.indentLevel = line.indent / 4;
        if (node.type === T.WRAP) {
          let content = '';
          for (let pos = start; pos < node.end - offset;) {
            const index = lineAt[pos];
            const ending = source[pos] === '\r' && source[pos + 1] === '\n' ? '\r\n' : source[pos];
            if (!lines[index].pure && (laterReal[index] || !laterPure[index])) content += ending;
            pos += ending.length;
          }
          node.content = content;
        }
      }
      tasks.push({ node, quoted, exit: true });
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
        tasks.push({ node: node.children![index], quoted: quoted || node.type === T.QUOTED, exit: false });
      continue;
    }
    if (quoted || node.type === T.QUOTED || !node.children) continue;
    const children: Node[] = [];
    for (const child of node.children) {
      const line = lines[row(child)];
      // A zero-level line also needs an anchor when a helper is later rebased.
      if (node.type !== T.LOOP && node.type !== T.ENUM && !trivia(child) && !child.synthetic &&
          child.start - offset === line.start && line.start > 0 && line.real)
        children.push(synthetic(T.BLANK, child, '', line.indent));
      children.push(child);
      const after = suffixes.get(child) ?? [];
      if (node.type === T.LOOP) suffixes.set(node, after);
      else for (const following of after) children.push(following);
    }
    node.children = children;
    if (node.type !== T.ENUM || node.synthetic || !children.length) continue;
    const groups = children;
    const leading = (group: Node) => {
      let end = 0;
      while (end < group.children!.length && trivia(group.children![end])) end++;
      return group.children!.slice(0, end);
    };
    const firstPrefix = leading(groups[0]);
    const breaks = firstPrefix.filter(child => child.type === T.WRAP).map(child => child.content).join('');
    const spacing = firstPrefix.filter(child => child.type === T.BLANK).map(child => child.content).join('');
    const firstIndent = firstPrefix.findLast(child => child.indentLevel !== undefined)?.indentLevel;
    const firstVisible = (group: Node): Node | undefined => {
      const search = [...group.children!].reverse();
      while (search.length) {
        const child = search.pop()!;
        if (trivia(child)) continue;
        if (!child.children || child.type === T.QUOTED) return child;
        for (let index = child.children.length - 1; index >= 0; index--) search.push(child.children[index]);
      }
    };
    const target = firstVisible(groups[0])?.indentLevel ?? node.indentLevel ?? 0;
    let tail: Node[] = [];
    for (const group of groups) {
      const delta = target - (firstVisible(group)?.indentLevel ?? target);
      if (delta) shiftIndentation(group, delta);
      const prefix = leading(group);
      for (const child of prefix) child.content = '';
      if (breaks) {
        let wrap = prefix.find(child => child.type === T.WRAP);
        if (!wrap) { wrap = synthetic(T.WRAP, group, ''); group.children!.unshift(wrap); }
        wrap.content = breaks;
      }
      if (spacing || firstIndent !== undefined) {
        let blank = prefix.findLast(child => child.type === T.BLANK);
        if (!blank) {
          blank = synthetic(T.BLANK, firstVisible(group) ?? group, '', firstIndent === undefined ? undefined : firstIndent * 4);
          const insert = group.children!.findIndex(child => child.type !== T.WRAP);
          group.children!.splice(insert < 0 ? group.children!.length : insert, 0, blank);
        }
        blank.content = spacing;
        if (firstIndent === undefined) delete blank.indentLevel;
        else blank.indentLevel = firstIndent;
      }
      let end = group.children!.length;
      while (end > 0 && trivia(group.children![end - 1])) end--;
      tail = group.children!.splice(end);
    }
    // Closing-line layout is common to all alternatives and must not repeat in LOOP.
    suffixes.set(node, tail);
  }
  for (const following of suffixes.get(root) ?? []) root.children?.push(following);
  return root;
}

/** Rebase a branch while preserving literal text and silent grammar-only indentation. */
function shiftIndentation(root: Node, amount: number): void {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.indentLevel !== undefined) {
      node.indentLevel = Math.max(0, node.indentLevel + amount);
      if (node.type === T.BLANK && !layoutOnly.has(node)) node.content = ' '.repeat(node.indentLevel * 4);
    }
    if (node.type !== T.QUOTED)
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) pending.push(node.children![index]);
  }
}

/** First-line anchors are supplied by the caller when a definition is expanded inline. */
export function leadingIndentation(root: Node): Set<Node> {
  const cached = leadingCache.get(root);
  if (cached) return cached;
  const result = new Set<Node>();
  const tasks: { node: Node; state: { broken: boolean } }[] = [{ node: root, state: { broken: false } }];
  while (tasks.length) {
    const { node, state } = tasks.pop()!;
    if (node.type === T.WRAP && /[\r\n]/.test(node.content)) state.broken = true;
    if (node.type === T.BLANK && node.indentLevel !== undefined && !state.broken) result.add(node);
    if (node.type === T.QUOTED) continue;
    const childState = { broken: state.broken };
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--)
      tasks.push({ node: node.children![index], state: node.type === T.ENUM ? { ...childState } : childState });
  }
  leadingCache.set(root, result);
  return result;
}

export const silentIndentation = (node: Node): boolean => layoutOnly.has(node);

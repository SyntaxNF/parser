import { Node, NodeType } from '../type';
import { SNFParseError } from '../error';
import { normalizeIndentation } from './layout';

const trivia = (node: Node) => node.type === NodeType.BLANK || node.type === NodeType.WRAP;
const repeatable = new Set([NodeType.VARIABLE, NodeType.OPTIONAL, NodeType.ENUM, NodeType.QUOTED]);

type Fail = (message: string, node: Node) => never;

/** Ignore separator formatting consistently in every syntax container. */
function readLoopSeparator(marker: Node[]): string {
  let separator = '';
  let pendingSpace = false;
  for (const part of marker) {
    if (part.type === NodeType.REPEAT) break;
    if (trivia(part)) {
      pendingSpace = separator.length > 0;
      continue;
    }
    if (pendingSpace) separator += ' ';
    separator += part.content;
    pendingSpace = false;
  }
  return separator.trim();
}

/** Normalize layout and bind postfix loops before resolving definitions. */
export function normalize(root: Node, source: string, block = 0, offset = 0): Node {
  const fail: Fail = (message, node) => {
    throw new SNFParseError(message, source, node.start);
  };
  const lineBreak = (char: string | undefined) => char === '\r' || char === '\n';
  const visit = (node: Node, quoted = false): Node => {
    if (node.type === NodeType.REPEAT) return fail('Repeat marker outside a postfix loop', node);
    quoted = quoted || node.type === NodeType.QUOTED;
    const copy: Node = { ...node, sourceBlock: block, start: node.start + offset, end: node.end + offset };
    if (node.type === NodeType.BLANK && !quoted && node.start > 0 && !lineBreak(source[node.start - 1]))
      copy.content = ' ';
    if (!node.children) return copy;
    const output: Node[] = [];
    const input = node.children;
    for (let i = 0; i < input.length; i++) {
      const child = input[i];
      // Classify by physical source lines, not the child's position in a container.
      if (!quoted && child.type === NodeType.BLANK && (child.end === source.length || lineBreak(source[child.end])))
        continue;
      if (child.type !== NodeType.LOOP) {
        const converted = visit(child, quoted);
        if (converted.type === NodeType.GROUP && !(converted.children ?? []).some(value => !trivia(value)))
          return fail('Empty alternative', child);
        output.push(converted);
        continue;
      }
      const marker = child.children ?? [];
      const significant = marker.filter(value => !trivia(value));
      if (
        significant.at(-1)?.type !== NodeType.REPEAT ||
        significant.filter(value => value.type === NodeType.REPEAT).length !== 1 ||
        significant
          .slice(0, -1)
          .some(value => ![NodeType.DEFINITION, NodeType.NUMBER, NodeType.OTHER].includes(value.type))
      ) {
        return fail('Invalid postfix loop separator', child);
      }
      let memberIndex = output.length - 1;
      while (memberIndex >= 0 && trivia(output[memberIndex])) memberIndex--;
      const member = output[memberIndex];
      if (!member || !repeatable.has(member.type))
        return fail('Postfix loop has no preceding complete repeatable item', child);
      output.splice(memberIndex);
      const start = member.start - offset;
      output.push({
        type: NodeType.LOOP,
        start: member.start,
        end: child.end + offset,
        sourceBlock: block,
        raw: source.slice(start, child.end),
        content: source.slice(start, child.end),
        children: [member],
        separator: readLoopSeparator(marker),
      });
    }
    copy.children = output;
    return copy;
  };
  return normalizeIndentation(visit(root), source, offset);
}

import { Node, NodeType, QuoteCharacter } from '../type';
import { SNFParseError } from '../error';

const trivia = (node: Node) => node.type === NodeType.BLANK || node.type === NodeType.WRAP;
const repeatable = new Set([NodeType.VARIABLE, NodeType.OPTIONAL, NodeType.ENUM, NodeType.QUOTED]);
const delimiter = (node: Node) => node.type === NodeType.QUOTE || node.type === NodeType.DOUBLEQUOTE;

type Fail = (message: string, node: Node) => never;

/** Read a whole quoted member, including SQL doubled delimiters. */
function readQuotedSequence(
  input: Node[],
  start: number,
  source: string,
  fail: Fail,
): { node: Node; end: number } {
  const opening = input[start];
  const inner: Node[] = [];
  let end = start + 1;
  for (; end < input.length; end++) {
    const candidate = input[end];
    if (candidate.type === opening.type) {
      const next = input[end + 1];
      if (next?.type !== opening.type || candidate.end !== next.start) break;
      // SQL doubled delimiters belong to one quoted member. Preserve
      // both characters so generation retains the original escaping.
      inner.push({
        ...candidate,
        type: NodeType.OTHER,
        end: next.end,
        raw: source.slice(candidate.start, next.end),
        content: candidate.content + next.content,
      });
      end++;
    } else inner.push(candidate);
  }
  if (end === input.length) return fail('Unclosed quote', opening);
  const closing = input[end];
  const node: Node = {
    type: NodeType.QUOTED,
    quote: opening.type === NodeType.QUOTE ? "'" : '"',
    start: opening.start,
    end: closing.end,
    raw: source.slice(opening.start, closing.end),
    content: source.slice(opening.end, closing.start),
    children: inner,
  };
  return { node, end };
}

/** Ignore separator formatting outside quotes while preserving literal whitespace inside. */
function readLoopSeparator(marker: Node[], quote?: QuoteCharacter): string {
  let separator = '';
  let pendingSpace = false;
  for (const part of marker) {
    if (part.type === NodeType.REPEAT) break;
    if (trivia(part) && !quote) {
      pendingSpace = separator.length > 0;
      continue;
    }
    if (pendingSpace) separator += ' ';
    separator += part.content;
    pendingSpace = false;
  }
  return separator.trim();
}

/** Finish quote grouping and postfix-loop binding before resolving definitions. */
export function normalize(root: Node, source: string, block = 0, offset = 0): Node {
  const fail: Fail = (message, node) => {
    throw new SNFParseError(message, source, node.start);
  };
  const visit = (node: Node, inheritedQuote?: QuoteCharacter): Node => {
    if (node.type === NodeType.REPEAT) return fail('Repeat marker outside a postfix loop', node);
    const quote = node.quote ?? inheritedQuote;
    const copy: Node = { ...node, sourceBlock: block, start: node.start + offset, end: node.end + offset };
    if (!node.children) return copy;
    const output: Node[] = [];
    const input = node.children;
    for (let i = 0; i < input.length; i++) {
      let child = input[i];
      if (delimiter(child) && quote) {
        // A surrounding quoted sequence owns its nested syntax too. Delimiters
        // in those children are literal text, not independent quote scopes.
        child = { ...child, type: NodeType.OTHER };
      } else if (delimiter(child)) {
        const quoted = readQuotedSequence(input, i, source, fail);
        child = quoted.node;
        i = quoted.end;
      }
      if (child.type !== NodeType.LOOP) {
        const converted = visit(child, quote);
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
        separator: readLoopSeparator(marker, quote),
      });
    }
    copy.children = output;
    return copy;
  };
  return visit(root);
}

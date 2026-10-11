import { compileDocument } from './internal/compiler';
import { Block, DocumentLine, DocumentLineType, SNFDocument } from './type';

const readLines = (content: string): DocumentLine[] => {
  const lines: DocumentLine[] = [];
  let start = 0;
  let line = 1;

  while (start < content.length) {
    let contentEnd = start;
    while (contentEnd < content.length && content[contentEnd] !== '\r' && content[contentEnd] !== '\n') {
      contentEnd++;
    }

    let end = contentEnd;
    if (content[end] === '\r' && content[end + 1] === '\n') {
      end += 2;
    } else if (content[end] === '\r' || content[end] === '\n') {
      end += 1;
    }

    const lineContent = content.slice(start, contentEnd);
    const type = !lineContent.trim()
      ? DocumentLineType.BLANK
      : lineContent.startsWith('#')
        ? DocumentLineType.COMMENT
        : DocumentLineType.CONTENT;
    lines.push({
      type,
      content: lineContent,
      ending: content.slice(contentEnd, end),
      start,
      end,
      line,
    });

    start = end;
    line++;
  }

  return lines;
};

export class SNFDocumentParser {
  parse(content: string): SNFDocument {
    const lines = readLines(content);
    const blocks: Block[] = [];
    let blockLines: DocumentLine[] = [];

    const appendBlock = () => {
      if (!blockLines.length) return;

      const comment = blockLines
        .filter(line => line.type === DocumentLineType.COMMENT)
        .map(line => line.content)
        .join('\n');
      const blockContent = blockLines
        .filter(line => line.type === DocumentLineType.CONTENT)
        .map(line => line.content)
        .join('\n');

      blocks.push({
        comment,
        content: blockContent,
        lines: blockLines,
        start: blockLines[0].start,
        end: blockLines.at(-1)!.end,
        startLine: blockLines[0].line,
        endLine: blockLines.at(-1)!.line,
      });
      blockLines = [];
    };

    for (const line of lines) {
      if (line.type === DocumentLineType.BLANK) {
        appendBlock();
      } else {
        blockLines.push(line);
      }
    }
    appendBlock();

    return compileDocument(content, lines, blocks);
  }
}

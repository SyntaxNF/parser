import { SNFParseError } from '../error';
import { Node, NodeType } from '../type';

interface CharType {
  char: string;
  decode: boolean;
  pos: number;
  end: number;
}

/** Internal syntax builder; public parsers attach metadata after the tree is complete. */
export class SyntaxParser {
  private keywords: string[] = ['[', '{', '|', '}', ']', `'`, `"`];
  private pos = 0;
  private lastPos = 0;
  private input = '';
  private closeStack: string[] = [];

  parse(input: string): Node {
    this.pos = 0;
    this.lastPos = 0;
    this.input = input;
    this.closeStack = [];
    return this.parseExpression();
  }

  private next(): CharType | undefined {
    if (this.pos >= this.input.length) return undefined;

    const now = this.pos;
    this.lastPos = now;
    const char = this.input[this.pos];
    this.pos++;

    if (char === '\\') {
      if (this.pos >= this.input.length) {
        throw new SNFParseError('Trailing escape character', this.input, now, 'an escaped character');
      }

      const decodedChar = this.input[this.pos];
      this.pos++;
      return { char: decodedChar, decode: true, pos: now, end: this.pos };
    }

    return { char, decode: false, pos: now, end: this.pos };
  }

  private back() {
    this.pos = this.lastPos;
  }

  private parseExpression(): Node {
    return this.parseNode(NodeType.ROOT);
  }

  private parseNode(type: NodeType = NodeType.COLLECTION): Node {
    const nodes: Node[] = [];
    const start = this.pos;
    let end = this.input.length;

    while (true) {
      const info = this.next();

      if (!info) {
        const expected = this.closeStack.at(-1);
        if (expected) {
          throw new SNFParseError(
            `Unclosed block, expected "${expected}"`,
            this.input,
            this.input.length,
            expected,
          );
        }
        break;
      }

      const char = info.char;
      const expected = this.closeStack.at(-1);
      if (!info.decode && char === expected) {
        end = info.pos;
        this.closeStack.pop();
        break;
      }

      if (!info.decode && (char === ']' || char === '}')) {
        throw new SNFParseError(`Unexpected closing character "${char}"`, this.input, info.pos, expected);
      }

      if (!info.decode && char === '[') {
        this.closeStack.push(']');
        nodes.push(this.parseOptional(info.pos));
      } else if (!info.decode && char === '{') {
        this.closeStack.push('}');
        nodes.push(this.parseEnum(info.pos));
      } else if (this.isRepeatStartChar(info)) {
        this.back();
        nodes.push(this.parseRepeat());
      } else if (this.isSplitStartChar(info)) {
        if (type !== NodeType.ENUM) {
          throw new SNFParseError(
            'Alternative separator "|" is only allowed directly inside an enumeration',
            this.input,
            info.pos,
            '{ ... | ... }',
          );
        }
        nodes.push({
          type: NodeType.SPLIT,
          content: '|',
          raw: '|',
          start: info.pos,
          end: info.end,
        });
      } else if (this.isVariableStartChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.VARIABLE, this.isVariableChar, this.isBlankChar));
      } else if (this.isDefinitionStartChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.DEFINITION, this.isDefinitionChar, this.isBlankChar));
      } else if (this.isNumberStartChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.NUMBER, this.isNumberChar, this.isBlankChar));
      } else if (this.isBlankChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.BLANK, this.isBlankChar, this.isNotBlankChar));
      } else if (this.isWrapChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.WRAP, this.isWrapChar, this.isNotWrapChar));
      } else if (!info.decode && char === `'`) {
        nodes.push({
          type: NodeType.QUOTE,
          content: `'`,
          raw: this.input.slice(info.pos, info.end),
          start: info.pos,
          end: info.end,
        });
      } else if (!info.decode && char === `"`) {
        nodes.push({
          type: NodeType.DOUBLEQUOTE,
          content: `"`,
          raw: this.input.slice(info.pos, info.end),
          start: info.pos,
          end: info.end,
        });
      } else if (this.isOtherStartChar(info)) {
        this.back();
        nodes.push(this.parseString(NodeType.OTHER, this.isOtherChar, this.isBlankChar));
      } else if (!/\s/.test(char)) {
        throw new SNFParseError(`Cannot parse character "${char}"`, this.input, info.pos);
      }
    }

    return {
      type,
      content: this.input.slice(start, end),
      raw: this.input.slice(start, end),
      start,
      end,
      children: nodes,
    };
  }

  private isWrapChar = (char: CharType): boolean => {
    return !char.decode && /[\r\n]/.test(char.char);
  };

  private isNotWrapChar = (char: CharType): boolean => {
    return !this.isWrapChar(char);
  };

  private isBlankChar = (char: CharType): boolean => {
    return !char.decode && /[ \t]/.test(char.char);
  };

  private isNotBlankChar = (char: CharType): boolean => {
    return !this.isBlankChar(char);
  };

  private isRepeatStartChar = (char: CharType): boolean => {
    return !char.decode && char.char === '.' && this.input.slice(char.pos, char.pos + 3) === '...';
  };

  private isSplitStartChar = (char: CharType): boolean => {
    return !char.decode && char.char === '|';
  };

  private isVariableStartChar = (char: CharType): boolean => {
    return /[a-z]/.test(char.char);
  };

  private isVariableChar = (char: CharType): boolean => {
    return /[a-z0-9_]/.test(char.char) || char.decode;
  };

  private isDefinitionStartChar = (char: CharType): boolean => {
    return /[A-Z]/.test(char.char);
  };

  private isDefinitionChar = (char: CharType): boolean => {
    return /[A-Z0-9_]/.test(char.char) || char.decode;
  };

  private isNumberStartChar = (char: CharType): boolean => {
    return /[0-9]/.test(char.char);
  };

  private isNumberChar = (char: CharType): boolean => {
    return /[0-9]/.test(char.char) || char.decode;
  };

  private isOtherStartChar = (char: CharType): boolean => {
    return /[^a-zA-Z0-9_\s]/.test(char.char) && (!this.keywords.includes(char.char) || char.decode);
  };

  private isOtherChar = (char: CharType): boolean => {
    if (this.isRepeatStartChar(char)) return false;
    return /[^a-zA-Z0-9_\s]/.test(char.char) && (!this.keywords.includes(char.char) || char.decode);
  };

  private parseRepeat(): Node {
    const start = this.pos;
    const end = start + 3;

    if (this.input.slice(start, end) !== '...') {
      throw new SNFParseError('Invalid repeat marker', this.input, start, '...');
    }
    if (this.input[end] === '.') {
      throw new SNFParseError('Repeat marker must contain exactly three dots', this.input, start, '...');
    }

    this.pos = end;
    return {
      type: NodeType.REPEAT,
      content: '...',
      raw: '...',
      start,
      end,
    };
  }

  private parseString(
    nodeType: NodeType,
    checkInner: (char: CharType) => boolean,
    checkEnd?: (char: CharType) => boolean,
  ): Node {
    let value = '';
    const start = this.pos;
    let end = this.input.length;

    while (true) {
      const info = this.next();
      if (!info) break;

      if (checkEnd?.(info) || !checkInner(info)) {
        end = info.pos;
        this.back();
        break;
      }

      value += info.char;
    }

    return {
      type: nodeType,
      content: value,
      raw: this.input.slice(start, end),
      start,
      end,
    };
  }

  private parseOptional(start: number): Node {
    const innerNode = this.parseNode(NodeType.OPTIONAL);
    const node: Node = {
      ...innerNode,
      start,
      end: innerNode.end + 1,
      raw: this.input.slice(start, innerNode.end + 1),
    };
    if (node.children?.some(child => child.type === NodeType.REPEAT)) {
      return { ...node, type: NodeType.LOOP };
    }
    return node;
  }

  private parseEnum(start: number): Node {
    const innerNode = this.parseNode(NodeType.ENUM);
    return this.groupedEnumChildren({
      ...innerNode,
      start,
      end: innerNode.end + 1,
      raw: this.input.slice(start, innerNode.end + 1),
    });
  }

  private groupedEnumChildren(node: Node): Node {
    const children = node.children ?? [];
    const grouped: Node[] = [];
    let groupStart = children[0]?.start ?? node.start;
    let currentChildren: Node[] = [];

    const appendGroup = (end: number) => {
      grouped.push({
        type: NodeType.GROUP,
        content: this.input.slice(groupStart, end),
        raw: this.input.slice(groupStart, end),
        start: groupStart,
        end,
        children: currentChildren,
      });
    };

    for (const child of children) {
      if (child.type === NodeType.SPLIT) {
        appendGroup(child.start);
        groupStart = child.end;
        currentChildren = [];
      } else {
        currentChildren.push(child);
      }
    }

    appendGroup(currentChildren.at(-1)?.end ?? groupStart);

    return {
      ...node,
      children: grouped,
    };
  }
}

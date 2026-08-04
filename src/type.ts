export enum NodeType {
  ROOT = 'root',
  COLLECTION = 'ct',
  LOOP = 'lo',
  OPTIONAL = 'op',
  ENUM = 'em',
  GROUP = 'g',
  SPLIT = 's',
  REPEAT = 'r',
  DEFINITION = 'd',
  VARIABLE = 'v',
  NUMBER = 'n',
  BLANK = 'b',
  WRAP = 'w',
  QUOTE = 'q',
  DOUBLEQUOTE = 'dq',
  OTHER = 'o',
}

export enum ExchangeType {
  BEFORE = 'b',
  AFTER = 'a',
  BOTH = 'ba',
}

export interface CharType {
  char: string;
  decode: boolean;
  pos: number;
  end: number;
}

export type QuoteCharacter = `'` | `"`;

export interface Node {
  type: NodeType;
  content: string;
  /** The exact source text represented by this node. */
  raw: string;
  /** Zero-based, half-open offsets into the parsed block content. */
  start: number;
  end: number;
  children?: Node[];
  name?: string;
  /** Optional metadata added by built-in opt-in walkers. */
  ast?: Node | Node[];
  quote?: QuoteCharacter;
  uid?: string;

  [key: string]: unknown;
}

export enum DocumentLineType {
  COMMENT = 'comment',
  CONTENT = 'content',
  BLANK = 'blank',
}

export interface DocumentLine {
  type: DocumentLineType;
  content: string;
  ending: string;
  /** Zero-based, half-open offsets into the original document source. */
  start: number;
  end: number;
  /** One-based physical line number. */
  line: number;
}

export interface Block {
  comment: string;
  content: string;
  ast: Node;
  lines: DocumentLine[];
  /** Zero-based, half-open offsets into the original document source. */
  start: number;
  end: number;
  /** One-based physical line numbers. */
  startLine: number;
  endLine: number;

  [key: string]: unknown;
}

export interface SNFDocument {
  type: 'document';
  content: string;
  lines: DocumentLine[];
  blocks: Block[];
}

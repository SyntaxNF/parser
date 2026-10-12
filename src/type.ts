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
  OTHER = 'o',
  QUOTED = 'qt',
  REFERENCE = 'rf',
  STATEMENT = 'st',
}

export type QuoteCharacter = `'` | `"`;

export interface ParseOptions {
  /** Omit template source payload and provenance from the returned AST/document. */
  simple?: boolean;
}

export interface Node {
  type: NodeType;
  /** Decoded leaf text (unquoted inline BLANKs are normalized); source text for containers. */
  content: string;
  /** The exact source text represented by this node. */
  raw: string;
  /** Zero-based, half-open offsets into the parsed block content. */
  start: number;
  end: number;
  children?: Node[];
  /** Dynamic-node label generated with the final UID. */
  name?: string;
  /** Source block index; offsets refer to that block's content. */
  sourceBlock?: number;
  /** Effective line indentation in four-column units; excluded from UID features. */
  indentLevel?: number;
  /** Synthetic containers or zero-width layout anchors have no complete source span. */
  synthetic?: boolean;
  /** A complete LOOP repeats children with this decoded delimiter (empty means whitespace). */
  separator?: string;
  /** Resolved recursive-reference target: the UID of a definition root. */
  target?: string;
  /** Source definition used at an expanded use site; excluded from identity. */
  binding?: { name: string; kind: DefinitionKind };
  /** STATEMENT categories are labels only; no external templates are loaded. */
  categories?: string[];
  quote?: QuoteCharacter;
  /** Stable identity assigned once after template compilation. */
  uid?: string;
}

/** Runtime AST view. Containers omit redundant source content; leaves retain decoded text. */
export type SimpleNode = Omit<Node, 'raw' | 'start' | 'end' | 'sourceBlock' | 'synthetic' | 'content' | 'children'> & {
  content?: string;
  children?: SimpleNode[];
};

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
  lines: DocumentLine[];
  /** Zero-based, half-open offsets into the original document source. */
  start: number;
  end: number;
  /** One-based physical line numbers. */
  startLine: number;
  endLine: number;
}

export interface SNFDocument {
  type: 'document';
  content: string;
  lines: DocumentLine[];
  blocks: Block[];
  entries: TemplateEntry[];
  definitions: TemplateDefinition[];
}

export type DefinitionKind = 'WHERE' | 'ONEOFIS' | 'PARTOFIS' | 'STATEMENT';
export interface TemplateEntry {
  name?: string;
  blocks: number[];
  dependencies: string[];
  ast: Node;
}
export interface TemplateDefinition {
  kind: DefinitionKind;
  names: string[];
  blocks: number[];
  dependencies: string[];
  recursive: boolean;
  ast: Node;
}

export type SimpleTemplateEntry = Omit<TemplateEntry, 'blocks' | 'ast'> & { ast: SimpleNode };
export type SimpleTemplateDefinition = Omit<TemplateDefinition, 'blocks' | 'ast'> & { ast: SimpleNode };
export type SimpleSNFDocument = Omit<SNFDocument, 'content' | 'lines' | 'blocks' | 'entries' | 'definitions'> & {
  entries: SimpleTemplateEntry[];
  definitions: SimpleTemplateDefinition[];
};

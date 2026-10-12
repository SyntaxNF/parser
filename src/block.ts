import { Node, ParseOptions, SimpleNode } from './type';
import { SyntaxParser } from './internal/syntax';
import { normalize } from './internal/normalize';
import { createIdentityAllocator } from './internal/identity';
import { simpleNode } from './internal/simple';
import { trimBoundaryBlanks } from './internal/layout';

/** Compiles a standalone SNF fragment. Document definitions use SNFDocumentParser. */
export class SNFParser {
  parse(input: string, options: ParseOptions & { simple: true }): SimpleNode;
  parse(input: string, options?: ParseOptions & { simple?: false }): Node;
  parse(input: string, options: ParseOptions): Node | SimpleNode;
  parse(input: string, options: ParseOptions = {}): Node | SimpleNode {
    const ast = createIdentityAllocator()(trimBoundaryBlanks(normalize(new SyntaxParser().parse(input), input)));
    return options.simple ? simpleNode(ast) : ast;
  }
}

import { Node } from './type';
import { SyntaxParser } from './internal/syntax';
import { normalize } from './internal/normalize';
import { createIdentityAllocator } from './internal/identity';

/** Compiles a standalone SNF fragment. Document definitions use SNFDocumentParser. */
export class SNFParser {
  parse(input: string): Node {
    return createIdentityAllocator()(normalize(new SyntaxParser().parse(input), input));
  }
}

export class SNFParseError extends SyntaxError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly expected?: string;

  constructor(message: string, input: string, offset: number, expected?: string) {
    const safeOffset = Math.max(0, Math.min(offset, input.length));
    const before = input.slice(0, safeOffset);
    const lines = before.split(/\r\n|\r|\n/);
    const line = lines.length;
    const column = (lines.at(-1)?.length ?? 0) + 1;

    super(`${message} at ${line}:${column}`);
    this.name = 'SNFParseError';
    this.offset = safeOffset;
    this.line = line;
    this.column = column;
    this.expected = expected;
  }
}

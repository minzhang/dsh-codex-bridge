/**
 * Lightweight single-line Pascal lexer used for display coloring only.
 *
 * Tokens always cover the input exactly: concatenating every token text in
 * order reproduces the input string. This is not a parser; multi-line comments
 * are not recognized across calls, so each call must receive one line.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';

export interface SyntaxToken {
  text: string;
  kind: TokenKind;
}

const KEYWORDS = new Set([
  'absolute',
  'abstract',
  'and',
  'array',
  'as',
  'asm',
  'assembler',
  'begin',
  'case',
  'class',
  'const',
  'constructor',
  'destructor',
  'dispinterface',
  'div',
  'do',
  'downto',
  'else',
  'end',
  'except',
  'exports',
  'external',
  'far',
  'file',
  'finalization',
  'finally',
  'for',
  'forward',
  'function',
  'goto',
  'if',
  'implementation',
  'in',
  'inherited',
  'initialization',
  'inline',
  'interface',
  'is',
  'label',
  'library',
  'message',
  'mod',
  'near',
  'nil',
  'not',
  'object',
  'of',
  'on',
  'or',
  'out',
  'packed',
  'procedure',
  'program',
  'property',
  'raise',
  'record',
  'repeat',
  'resourcestring',
  'set',
  'shl',
  'shr',
  'string',
  'then',
  'threadvar',
  'to',
  'try',
  'type',
  'unit',
  'until',
  'uses',
  'var',
  'while',
  'with',
  'xor',
]);

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const DECIMAL_NUMBER = /^\d+(?:\.\d+)?/;
const HEX_NUMBER = /^\$[0-9A-Fa-f]+/;

/** Split one line into display tokens without adding, dropping, or changing text. */
export function highlightLine(text: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];

    if (char === "'") {
      const end = scanString(text, index);
      pushToken(tokens, text.slice(index, end), 'string');
      index = end;
      continue;
    }

    if (char === '{') {
      const close = text.indexOf('}', index + 1);
      const end = close === -1 ? text.length : close + 1;
      pushToken(tokens, text.slice(index, end), 'comment');
      index = end;
      continue;
    }

    if (char === '(' && next === '*') {
      const close = text.indexOf('*)', index + 2);
      const end = close === -1 ? text.length : close + 2;
      pushToken(tokens, text.slice(index, end), 'comment');
      index = end;
      continue;
    }

    if (char === '/' && next === '/') {
      pushToken(tokens, text.slice(index), 'comment');
      index = text.length;
      continue;
    }

    if (char === '$') {
      const match = HEX_NUMBER.exec(text.slice(index));
      if (match !== null) {
        pushToken(tokens, match[0], 'number');
        index += match[0].length;
        continue;
      }
    }

    if (char >= '0' && char <= '9') {
      const match = DECIMAL_NUMBER.exec(text.slice(index));
      if (match !== null) {
        pushToken(tokens, match[0], 'number');
        index += match[0].length;
        continue;
      }
    }

    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end] ?? '')) {
        end += 1;
      }
      const word = text.slice(index, end);
      pushToken(tokens, word, KEYWORDS.has(word.toLowerCase()) ? 'keyword' : 'plain');
      index = end;
      continue;
    }

    pushToken(tokens, char, 'plain');
    index += 1;
  }

  return tokens;
}

function scanString(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length) {
    if (text[index] === "'") {
      if (text[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }

  return text.length;
}

function pushToken(tokens: SyntaxToken[], text: string, kind: TokenKind): void {
  if (text === '') {
    return;
  }
  const last = tokens[tokens.length - 1];
  if (kind === 'plain' && last !== undefined && last.kind === 'plain') {
    tokens[tokens.length - 1] = { text: last.text + text, kind: 'plain' };
    return;
  }
  tokens.push({ text, kind });
}

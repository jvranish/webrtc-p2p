export class ParseError extends Error {
  /**
   * @param {string} expected
   * @param {string} found
   * @param {number} pos
   * @param {string} context
   */
  constructor(expected, found, pos, context) {
    // TODO make `found` an ADT character/value/EOF
    super(
      `Parse error at ${pos}, expected: ${expected}, but found: '${found}'\n${context}`
    );
    this.name = "ParseError";
    this.expected = expected;
    this.pos = pos;
    this.context = context;
  }
}

// The reason why this works without having to save/restore a copy of the parser state on combinators like `many` is because
// combinators like many/any only allow failures to happen if the parser did not consume any input.

export class ParserState {
  /**
   * @param {string[]} strings
   * @param {unknown[]} values
   */
  constructor(strings, values, stringsValuesIndex = 0, pos = 0) {
    this.strings = strings;
    this.values = values;
    this.stringsValuesIndex = stringsValuesIndex;
    this.pos = pos;
  }

  /** @param {string} s */
  static parse(s) {
    return new this([s], []);
  }

  copy() {
    return new ParserState(
      // don't mutate strings or values or we'll be in a world of hurt
      this.strings,
      this.values,
      this.stringsValuesIndex,
      this.pos
    );
  }
  /** @param {ParserState} other */
  equals(other) {
    return (
      this.strings === other.strings &&
      this.values === other.values &&
      this.stringsValuesIndex === other.stringsValuesIndex &&
      this.pos === other.pos
    );
  }

  /** @param {ParserState} other */
  backtrack(other) {
    this.stringsValuesIndex = other.stringsValuesIndex;
    this.pos = other.pos;
  }

  /**
   * @param {string} s
   * @returns {never}
   */
  expected(s) {
    const errorPos = this.strings
      .slice(0, this.stringsValuesIndex)
      .reduce((a, b) => a + b.length, this.pos);
    const nextCharacter = this.nextTokenIsValue()
      ? "template value"
      : this.atEOF()
      ? "EOF"
      : this.strings[this.stringsValuesIndex][this.pos];

    const valuePlaceholder = "${...}";

    const correctedPos = errorPos + (this.stringsValuesIndex * valuePlaceholder.length);

    // Build context string showing where the error occurred
    const fullInput = this.strings.join(valuePlaceholder);
    const contextRadius = 40;
    const start = Math.max(0, correctedPos - contextRadius);
    const end = Math.min(fullInput.length, correctedPos + contextRadius);
    const snippet = fullInput.slice(start, end);

    const snippetErrorPos = correctedPos - start;

    // Find the last newline before the error position in the snippet
    const snippetBeforeError = snippet.slice(0, snippetErrorPos);
    const lastNewlineIndex = snippetBeforeError.lastIndexOf("\n");
    const caretPos =
      lastNewlineIndex === -1
        ? snippetErrorPos
        : snippetErrorPos - lastNewlineIndex - 1; // -1 for '\n'

    // Find the next newline after the error position to insert caret on the line right after the error
    const snippetAfterError = snippet.slice(snippetErrorPos);
    const nextNewlineIndex = snippetAfterError.indexOf("\n");
    const errorLineEnd =
      nextNewlineIndex === -1
        ? snippet.length
        : snippetErrorPos + nextNewlineIndex;

    const beforeErrorLine = snippet.slice(0, errorLineEnd);
    const afterErrorLine = snippet.slice(errorLineEnd);
    const caretLine = " ".repeat(caretPos) + "^";

    const context = `${beforeErrorLine}\n${caretLine}${afterErrorLine}`;

    throw new ParseError(s, nextCharacter, correctedPos, context);
  }

  /**
   * @param {RegExp} regex
   * @param {string | undefined} [name]
   */
  regex(regex, name) {
    const match = regex.exec(
      this.strings[this.stringsValuesIndex].slice(this.pos)
    );
    if (match && match.index === 0) {
      const value = match[0];
      this.pos += value.length;
      return value;
    } else {
      this.expected(name ? `${name} (${regex.toString()})` : regex.toString());
    }
  }

  /** @param {string} s */
  str(s) {
    if (this.strings[this.stringsValuesIndex].startsWith(s, this.pos)) {
      this.pos += s.length;
    } else {
      this.expected(s);
    }
  }

  /** @param {string} c */
  untilChar(c) {
    const index = this.strings[this.stringsValuesIndex].indexOf(c, this.pos);
    if (index === -1) {
      this.expected(`character '${c}'`);
    }
    const value = this.strings[this.stringsValuesIndex].slice(this.pos, index);
    this.pos = index;
    return value;
  }

  nextTokenIsValue() {
    return (
      this.pos === this.strings[this.stringsValuesIndex].length &&
      this.stringsValuesIndex < this.values.length
    );
  }

  atEOF() {
    return (
      this.stringsValuesIndex === this.strings.length - 1 &&
      this.pos === this.strings[this.stringsValuesIndex].length
    );
  }

  /**
   * @template T
   * @param {(value: unknown) => value is T} predicate
   * @returns {T}
   */
  valueOf(predicate) {
    if (this.nextTokenIsValue()) {
      const value = this.values[this.stringsValuesIndex];
      if (predicate(value)) {
        this.stringsValuesIndex++;
        this.pos = 0;
        return value;
      } else {
        this.expected("value of type " + predicate.name);
      }
    } else {
      this.expected("template value");
    }
  }

  eof() {
    if (!this.atEOF()) {
      this.expected("EOF");
    }
  }
}

/**
 * @template T
 * @typedef {(state: ParserState) => T} Parser
 */

/** @type {(s: string) => Parser<never>} */
export const expected = (s) => (state) => {
  return state.expected(s);
};

/**
 * @template T
 * @param {(value: unknown) => value is T} predicate
 * @returns {Parser<T>}
 */
export const valueOf = (predicate) => (state) => state.valueOf(predicate);

/**
 * @param {unknown} _x
 * @returns {_x is any}
 */
export const anything = (_x) => true;

export const anyValue = valueOf(anything);

/**
 * @param {RegExp} regex
 * @param {string | undefined} [name]
 * @returns {Parser<string>}
 */
export const regex = (regex, name) => (state) => {
  return state.regex(regex, name);
};

/**
 * @param {string} s
 * @returns {Parser<string>}
 */
export const str = (s) => (state) => {
  state.str(s);
  return s;
};

/**
 * @param {string} c
 * @returns {Parser<string>}
 */
export const untilChar = (c) => (state) => state.untilChar(c);

/** @type {<T>(p: Parser<T>) => Parser<T | undefined>} */
export const optional = (p) => or(p, constant(undefined));

/**
 * @template T
 * @param {Parser<T>} p
 * @returns {Parser<
 *   | { value: T; consumed: boolean; error?: undefined }
 *   | { error: ParseError; value?: undefined }
 * >}
 */
export const tryParse = (p) => (state) => {
  const initialState = state.copy();
  try {
    const value = p(state);
    const consumed = !state.equals(initialState);
    return { value, consumed };
  } catch (e) {
    // If we get a parse error, but we haven't consumed any input, then we can
    // possibly move on to another alternative, otherwise we should rethrow the
    // error.
    if (state.equals(initialState) && e instanceof ParseError) {
      return { error: e };
    } else {
      throw e;
    }
  }
};

export const whitespace = regex(/^\s+/);

export const anyWhitespace = regex(/^\s*/);

/**
 * @template T
 * @param {Parser<T>} p
 * @returns {Parser<T>}
 */
export const token = (p) => (state) => {
  const value = p(state);
  anyWhitespace(state);
  return value;
};

/**
 * @param {string} s
 * @returns {Parser<string>}
 */
export const strToken = (s) => token(str(s));

/**
 * @template T
 * @param {Parser<unknown>} q
 * @param {Parser<T>} p
 * @returns {Parser<T>}
 */
export const between = (q, p) => (state) => {
  q(state);
  const value = p(state);
  q(state);
  return value;
};

// TODO fix this with variadic tuple types

/**
 * @template T
 * @param {Parser<T>[]} ps
 * @returns {Parser<T>}
 */
export const any =
  (...ps) =>
  (state) => {
    /** @type {ParseError[]} */
    const errors = [];
    for (const p of ps) {
      const r = tryParse(p)(state);
      if (!r.error) {
        return r.value;
      }
      errors.push(r.error);
    }
    return expected(errors.map((e) => e.expected).join(" or "))(state);
  };

/** @type {<A, B>(a: Parser<A>, b: Parser<B>) => Parser<A | B>} */
// @ts-ignore: This is actually a "more correct" type for `any`, but doesn't work with the current implementation
export const or = (a, b) => any(a, b);

/** @type {<A, B>(a: Parser<A>, b: Parser<B>) => Parser<[A, B]>} */
export const and = (p, q) => (state) => {
  const a = p(state);
  const b = q(state);
  return [a, b];
};

/**
 * @template T
 * @param {Parser<T>} p
 * @returns {Parser<T[]>}
 */
export const many = (p) => (state) => {
  const values = [];
  while (true) {
    const r = tryParse(p)(state);
    if (r.error) {
      return values;
    } else {
      if (r.consumed === false) {
        throw new Error(`Parser succeeded, but did not consume any input.
      This is almost certainly a bug, and would have caused an infinite loop.`);
      }
    }
    values.push(r.value);
  }
};

/**
 * @template T
 * @param {Parser<T>} p
 * @returns {Parser<T[]>}
 */
export const many1 = (p) => (state) => {
  return [p(state), ...many(p)(state)];
};

/**
 * @template T
 * @param {Parser<T>} p
 * @param {Parser<unknown>} sep
 * @returns {Parser<T[]>}
 */
export const sepBy = (p, sep) => (state) =>
  [
    p(state),
    ...many((state) => {
      sep(state);
      return p(state);
    })(state),
  ];

/** @type Parser<void> */
export const eof = (state) => {
  state.eof();
};

/** @type {<A, B>(f: (a: A) => B, p: Parser<A>) => Parser<B>} */
export const map = (f, p) => (state) => f(p(state));

/** @type {<T>(value: T) => Parser<T>} */
export const constant = (value) => (_state) => value;

/** @type {<T>(p: Parser<unknown>, q: Parser<T>) => Parser<T>} */
export const then = (p, q) => (state) => {
  p(state);
  return q(state);
};

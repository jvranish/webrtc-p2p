// https://www.w3.org/TR/2014/REC-html5-20141028/syntax.html#elements-0

import {
  ParserState,
  anyValue,
  valueOf,
  regex,
  str,
  optional,
  anyWhitespace,
  token,
  strToken,
  any,
  or,
  many,
  eof,
  constant,
  map,
  untilChar,
} from "./parser.js";

/**
 * @import {Parser} from "./parser.js"
 * @import {TagNode, AstNode, CommentNode, AttributeLiteralValue, AttributeRef, AttributeHole, AttributeSplatHole, Attribute, ElementHole} from "./html-types.js"
 */

/** @type {(value: unknown) => value is object | null} */
const isObject = (value) => typeof value === "object";

// HTML void elements that cannot have children or closing tags
// https://html.spec.whatwg.org/multipage/syntax.html#void-elements
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// Tag names must be only alphanumeric characters
// (I'm unsure if they are allowed to start with a number, but that seems dumb)
const tagName = token(regex(/^[a-zA-Z][a-zA-Z0-9\-]*/, "tag name"));

// Attribute names must consist of one or more characters other than the
// space characters, U+0000 NULL, U+0022 QUOTATION MARK ("), U+0027
// APOSTROPHE ('), ">" (U+003E), "/" (U+002F), and "=" (U+003D) characters,
// the control characters, and any characters that are not defined by
// Unicode.
const attributeName = token(
  // deno-lint-ignore no-control-regex
  regex(/^[^ "'>/=\u0000-\u001F\u007F-\u009F]+/, "attribute name"),
);

/** @type {(name: string, direct: boolean) => Parser<AttributeLiteralValue>} */
const unquotedAttributeValue = (name, direct) =>
  map(
    (value) => ({ type: "literal", name, value, direct }),
    regex(/^[^\s"'`=<>/`]+/, "unquoted attribute value"),
  );

/** @type {(name: string, direct: boolean) => (quote: string) => Parser<AttributeLiteralValue>} */
const quotedStringAttributeValue = (name, direct) => (quote) => (state) => {
  const value = untilChar(quote)(state);
  return { type: "literal", name, value, direct };
};

/** @type {(name: string, direct: boolean) => Parser<AttributeHole>} */
const templateAttributeValue = (name, direct) => (state) => {
  const index = state.stringsValuesIndex;
  const value = anyValue(state);
  return { type: "attribute-hole", index, value, name, direct };
};

/** @type {(name: string, direct: boolean) => Parser<AttributeLiteralValue | AttributeHole>} */
const quotedAttributeValue = (name, direct) => (state) => {
  const quote = any(str("'"), str('"'))(state);
  const value = or(
    templateAttributeValue(name, direct),
    quotedStringAttributeValue(name, direct)(quote),
  )(state);
  str(quote)(state);
  return value;
};

/** @type {(name: string, direct: boolean) => Parser<AttributeLiteralValue>} */
const booleanAttribute = (name, direct) =>
  constant({ type: "literal", name, value: true, direct });

/**
 * @type {(
 *   name: string,
 *   direct: boolean
 * ) => Parser<AttributeLiteralValue | AttributeHole>}
 */
const attributeValue = (name, direct) => (state) => {
  strToken("=")(state);
  return token(
    or(
      templateAttributeValue(name, direct), // ${x}
      or(
        quotedAttributeValue(name, direct), // "foo" or 'foo' or "${x}" or '${x}'
        unquotedAttributeValue(name, direct), // foo
      ),
    ),
  )(state);
};

/** @type {Parser<AttributeLiteralValue | AttributeHole>} */
const attribute = (state) => {
  const direct = !!optional(strToken("."))(state);
  const name = attributeName(state);
  const value = or(
    attributeValue(name, direct),
    booleanAttribute(name, direct),
  )(state);
  return value;
};

/** @type {Parser<AttributeRef>} */
const attributeRef = (state) => {
  strToken("#")(state);
  const name = attributeName(state);
  return { type: "ref", name };
};

/** @type {Parser<AttributeSplatHole>} */
const propsSplat = (state) => {
  const direct = !!optional(strToken("..."))(state);
  // dirty hack to get the index of the current value
  const index = state.stringsValuesIndex;
  const props = token(valueOf(isObject))(state);
  return { type: "attribute-splat-hole", index, props, direct };
};

/** @type {Parser<Attribute[]>} */
const attributes = many(or(attributeRef, or(propsSplat, attribute)));

/** @type {Parser<AstNode>} */
const text = (state) => {
  const value = regex(/^[^<]+/s, "text")(state);
  return { type: "text", value };
};

/** @type {Parser<string>} */
const blankValue = (state) => {
  anyValue(state);
  return "";
};

/** @type {Parser<CommentNode>} */
const comment = (state) => {
  strToken("<!--")(state);
  // allow comments to comment out value substitutions
  const comment = many(or(blankValue, regex(/^((?!-->).)+/s)))(state);
  strToken("-->")(state);
  return { type: "comment", comment };
};

/** @type {Parser<TagNode>} */
const tag = (state) => {
  regex(/^<(?!\/)/, "tag start")(state);
  const name = tagName(state);
  const attrs = attributes(state);
  const isVoid = VOID_ELEMENTS.has(name.toLowerCase());
  const childNodes = any(
    (state) => {
      strToken("/>")(state);
      return [];
    },
    (state) => {
      strToken(">")(state);
      // Void elements cannot have children or closing tags
      if (isVoid) {
        return [];
      }
      const c = elements(state);
      // strToken(`</${name}>`)(state);
      strToken(`</${name}`)(state);
      strToken(`>`)(state);
      return c;
    },
  )(state);
  return {
    type: "tag",
    name,
    attributes: attrs,
    childNodes,
  };
};

/** @type {Parser<ElementHole>} */
const elementHole = (state) => {
  const index = state.stringsValuesIndex;
  const value = anyValue(state);
  return { type: "element-hole", index, value };
};

/** @returns {Parser<AstNode[]>} */
const elements = many(any(elementHole, comment, tag, text));

/** @type {Parser<AstNode[]>} */
const html = (state) => {
  anyWhitespace(state); // allow leading whitespace
  const ast = elements(state);
  eof(state); // ensure we've parsed the whole input
  return ast;
};

/**
 * @type {(
 *   strings: TemplateStringsArray,
 *   ...values: unknown[]
 * ) => AstNode[]}
 */
export const parse = (strings, ...values) => {
  const parserState = new ParserState(Array.from(strings), values);
  return html(parserState);
};

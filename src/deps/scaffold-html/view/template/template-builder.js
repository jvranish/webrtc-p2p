import { parse } from "./html.js";

/** @import {Template, TemplateHole, TemplateElementRef} from "./template-builder-types.js" */
/** @import {AstNode} from "./html-types.js" */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// This is the main cache
/** @type {Map<TemplateStringsArray, Template>} */
const templateCache = new Map();


/**
 * @param {TemplateStringsArray} strings
 * @param {unknown[]} values
 * @param {string | null} [namespace]
 */
export function getTemplate(strings, values, namespace = null) {
  let template = templateCache.get(strings);
  if (template) {
    return template;
  }

  template = TemplateBuilder.create(strings, values, namespace);
  templateCache.set(strings, template);
  return template;
}

export class TemplateBuilder {
  /**
   * @param {string | null} namespace
   */
  constructor(namespace = null) {
    this.next_data_ref = 0;
    /** @type {TemplateHole[]} */
    this.holes = [];
    /** @type {TemplateElementRef[]} */
    this.refs = [];
    /** @type {string | null} */
    this.namespace = namespace;
  }

  /**
   * @param {Element} element
   */
  addRef(element) {
    const existingRef = element.getAttribute("data-template-ref");
    if (existingRef) {
      return existingRef;
    }

    const ref = String(this.next_data_ref++);
    element.setAttribute("data-template-ref", ref);
    return ref;
  }

  /**
   * Decode HTML entities in text using innerHTML (only called for static template text)
   * @param {string} text
   * @returns {string}
   */
  static decodeEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  }

  /**
  * Creates DOM elements and builds up a list of template holes from the AST, recursively
  * @param {AstNode} ast
  * @returns {Node}
  */
  createElement(ast) {
    switch (ast.type) {
      case "tag": {
        const childNodes = ast.childNodes.map((a) => this.createElement(a)).flat();
        const element = this.namespace
          ? document.createElementNS(this.namespace, ast.name)
          : document.createElement(ast.name);
        for (const attribute of ast.attributes) {
          switch (attribute.type) {
            case "literal": {
              if (attribute.direct) {
                // @ts-ignore we expect the user to know what they are doing here
                element[attribute.name] = attribute.value;
              } else {
                if (typeof attribute.value === "boolean") {
                  if (attribute.value) {
                    element.setAttribute(attribute.name, "");
                  }
                } else {
                  element.setAttribute(attribute.name, attribute.value);
                }
              }
              break;
            }
            case "ref": {
              const dataTemplateRef = this.addRef(element);
              const name = attribute.name;
              this.refs.push({name, dataTemplateRef});
              break;
            }
            case "attribute-hole": {
              const direct = attribute.direct;
              const dataTemplateRef = this.addRef(element);
              const index = attribute.index;
              const name = attribute.name;
              this.holes.push({ type: "attribute", index, dataTemplateRef, name, direct });
              break;
            }
            case "attribute-splat-hole": {
              const direct = attribute.direct;
              const dataTemplateRef = this.addRef(element);
              const index = attribute.index;
              this.holes.push({ type: "attribute-splat", index, dataTemplateRef, direct});
              break;
            }
          }
        }
        childNodes.forEach((child) => element.append(child));
        return element;
      }
      case "text": {
        // Decode HTML entities in static template text only (not interpolated values)
        const decodedText = TemplateBuilder.decodeEntities(ast.value);
        return document.createTextNode(decodedText);
      }
      case "comment": {
        return document.createComment(ast.comment.join(" "));
      }
      case "element-hole": {
        // what do I do if this is a function? assume it's a single node and push a TemplateElementAnchor
        // create dummy element, with data-template-ref
        // I have to create a dummy element because I can't query for
        // comments or text nodes with querySelector. We replace this node
        // with a comment later when we instantiate the template
        const dummyElement = document.createElement("div");
        const dataTemplateRef = this.addRef(dummyElement);
        const index = ast.index;
        this.holes.push({ type: "element", index, dataTemplateRef });
        return dummyElement;
      }
    }
  }

  /**
   * @param {TemplateStringsArray} strings
   * @param {unknown[]} values
   * @param {string | null} [namespace]
   * @return {Template}
   */
  static create(strings, values, namespace = null) {
    const builder = new TemplateBuilder(namespace);
    const astNodes = parse(strings, ...values);

    const fragment = document.createDocumentFragment();
    for (const node of astNodes) {
      fragment.appendChild(builder.createElement(node));
    }

    const holes = builder.holes;
    const templateKey = strings;
    const refs = builder.refs;

    return { templateKey, fragment, holes, refs };
  }
}

export class PopulatedTemplate {
  /**
   * @param {TemplateStringsArray} templateKey
   * @param {unknown[]} values
   */
  constructor(templateKey, values) {
    this.templateKey = templateKey;
    this.values = values;
  }
}

/**
 * @param {TemplateStringsArray} strings
 * @param {unknown[]} values
 * @returns {PopulatedTemplate}
 */
export function html(strings, ...values) {
  const template = getTemplate(strings, values);
  // It's important to use `template.templateKey` rather than `strings` here
  // otherwise we'll break our second level of caching if two
  // `TemplateStringsArray` are otherwise identical, but don't compare as
  // identical. (see comment in `getTemplate`)
  return new PopulatedTemplate(template.templateKey, values);
}

/**
 * @param {TemplateStringsArray} strings
 * @param {unknown[]} values
 * @returns {PopulatedTemplate}
 */
export function svg(strings, ...values) {
  const template = getTemplate(strings, values, SVG_NAMESPACE);
  return new PopulatedTemplate(template.templateKey, values);
}


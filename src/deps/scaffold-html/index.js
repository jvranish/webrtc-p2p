
import { RenderedView } from "./view/index.js";
export { html, svg } from "./view/template/template-builder.js";
export { RenderedView } from "./view/index.js";
export { asComponent } from "./view/component.js";
export { PopulatedTemplate } from "./view/template/template-builder.js";

/**
 * @template S
 * @template P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {import("./view/component.js").ComponentContext<S, P, R>} ComponentContext
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {import("./view/component.js").ComponentDefinition<S, P, R>} ComponentDefinition
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {import("./view/component.js").ComponentInstance<S, P, R>} ComponentInstance
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {import("./view/component.js").Component<S, P, R>} Component
 */

/** @typedef {import("./view/view-types.js").Renderable} Renderable */

/**
 * Render a value into the DOM.
 *
 * @param {Renderable} value
 * @param {Node} parentNode
 * @param {Node | null} referenceNode
 */
export function render(value, parentNode, referenceNode = null) {
  return RenderedView.render(value, parentNode, referenceNode);
}

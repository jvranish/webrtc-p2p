
import { RenderedView } from "./view/index.js";
export { html, svg } from "./view/template/template-builder.js";
export { RenderedView } from "./view/index.js";
export { asComponent } from "./view/component.js";
export { PopulatedTemplate } from "./view/template/template-builder.js";

/** @import {ComponentContext, ComponentDefinition, ComponentInstance, Component} from "./view/component.js" */

/**
 * @template S
 * @template P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {ComponentContext<S, P, R>} ComponentContext
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {ComponentDefinition<S, P, R>} ComponentDefinition
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {ComponentInstance<S, P, R>} ComponentInstance
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {Component<S, P, R>} Component
 */

/** @import {Renderable} from "./view/view-types.js" */
/** @typedef {Renderable} Renderable */

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

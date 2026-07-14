import { ComponentView } from "./component.js";
import { KeyedListView } from "./keyed-list.js";
import { ListView } from "./list.js";
import { TemplateView } from "./template.js";
import { TextView } from "./text.js";
/** @import { ViewClass, ViewInstance} from "./view-types.js" */
/** @import {Renderable} from "./view-types.js" */

const registry = {
  TextView,
  TemplateView,
  KeyedListView,
  ListView,
  ComponentView,
};

/** @typedef {InstanceType<(typeof registry)[keyof typeof registry]>} View */

export class RenderedView {
  /** @param {View} view */
  constructor(view) {
    this.view = view;
  }

  /**
   * @template T
   * @param {ViewInstance<T>} view
   * @param {T} value
   */
  #updateView(view, value) {
    const viewClass = /** @type {ViewClass<T>} */(view.constructor);
    return viewClass.isValue(value) && view.update(value);
  }

  /** @param {Renderable} value */
  update(value) {
    if (this.#updateView(this.view, value)) {
      //We were already be the right type of view
      return;
    }
    // we got a different type of value, need to re-render
    const referenceNode = this.referenceNode();
    const parentNode = referenceNode?.parentNode;
    if (!parentNode) {
      // we're not attached to the DOM so we can't re-render
      return;
    }
    for (const viewClass of Object.values(registry)) {
      const renderedView = RenderedView.renderView(
        viewClass,
        value,
        parentNode,
        referenceNode
      );
      if (renderedView) {
        this.remove();
        this.view = renderedView;
        return;
      }
    }
    throw new Error(`Unsupported view value: ${value}`);
  }

  /**
   * @template T
   * @param {ViewClass<T>} viewClass
   * @param {T} value
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static renderView(viewClass, value, parentNode, referenceNode) {
    if (viewClass.isValue(value)) {
      return viewClass.render(value, parentNode, referenceNode);
    } else {
      return undefined;
    }
  }

  /**
   * Render a value into the DOM.
   *
   * @param {Renderable} value
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   * @returns {RenderedView}
   */
  static render(value, parentNode, referenceNode) {
    for (const viewClass of Object.values(registry)) {
      const renderedView = this.renderView(viewClass, value, parentNode, referenceNode);
      if (renderedView) {
        return new RenderedView(renderedView);
      }
    }
    throw new Error(`Unsupported view value: ${value}`);
  }


  remove() {
    const nodes = this.getNodes();
    // All views are required to have at least one node
    const parentNode = nodes[0]?.parentNode;
    if (parentNode) {
      for (const node of nodes) {
        parentNode.removeChild(node);
      }
    }
  }

  /** @param {Node} referenceNode */
  insertBefore(referenceNode) {
    const parentNode = referenceNode.parentNode;
    if (!parentNode) {
      // if no parent node, not much to do
      return;
    }
    for (const node of this.getNodes()) {
      parentNode.insertBefore(node, referenceNode);
    }
  }

  referenceNode() {
    // All views are required to have at least one node
    return this.view.getNodes()[0];
  }

  getNodes() {
    // All views are required to have at least one node
    return this.view.getNodes();
  }
}

import { RenderedView } from "./index.js";
/** @import {Renderable} from "./view-types.js" */

export class ListView {
  /**
   * @param {RenderedView[]} renderTemplates
   * @param {Node} anchorNode
   */
  constructor(renderTemplates, anchorNode) {
    this.renderTemplates = renderTemplates;
    this.anchorNode = anchorNode;
  }

  /**
   * @param {unknown} value
   * @returns {value is Renderable[]}
   */
  static isValue(value) {
    return Array.isArray(value);
  }

  /**
   * Render the list into the DOM.
   *
   * @param {Renderable[]} values
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static render(values, parentNode, referenceNode) {
    const renderTemplates = values.map((value) =>
      RenderedView.render(value, parentNode, referenceNode)
    );
    // We have a rule that every view must _always_ have some node in the DOM.
    // Since lists can be empty we leave a comment after the list so we don't
    // have to worry about it. Without the "must always have at least one node"
    // rule, we'd need parentNode and referenceNode passed to update, which
    // would significantly complicate things.
    const anchorNode = document.createComment("");
    parentNode.insertBefore(anchorNode, referenceNode);
    return new ListView(renderTemplates, anchorNode);
  }

  /**
   * Update the list with new values.
   *
   * @param {Renderable[]} values
   */
  update(values) {
    const referenceNode = this.anchorNode;
    const parentNode = referenceNode.parentNode;
    if (!parentNode) {
      return false;
    }
    // Remove extra renderTemplates
    while (this.renderTemplates.length > values.length) {
      const renderedView = this.renderTemplates.pop();
      if (renderedView) {
        renderedView.remove();
      }
    }
    values.forEach((value, i) => {
      if (i < this.renderTemplates.length) {
        // update existing renderedView
        this.renderTemplates[i].update(value);
      } else {
        // need to add a new renderedView
        this.renderTemplates.push(
          RenderedView.render(value, parentNode, referenceNode)
        );
      }
    });
    return true;
  }

  getNodes() {
    /** @type {Node[]} */
    const nodes = [];
    for (const renderedView of this.renderTemplates) {
      nodes.push(...renderedView.getNodes());
    }
    nodes.push(this.anchorNode);
    return nodes;
  }
}

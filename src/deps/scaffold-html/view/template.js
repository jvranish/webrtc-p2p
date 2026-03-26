import { getTemplate, PopulatedTemplate } from "./template/template-builder.js";
import { RenderedView } from "./index.js";
import { updateAttribute } from "./update-attribute.js";
/** @import {ElementHole, Hole, TopLevelElement} from "./template-types.js" */
/** @import {Renderable} from "./view-types.js" */

/**
 * @typedef {Map<
 *   Node,
 *   {
 *     listener: (event: Event) => void;
 *     handlers: Record<string, (event: Event) => void>;
 *   }
 * >} EventHandlersMap
 */

/**
 * @param {EventHandlersMap} eventHandlerMap
 * @param {Node} node
 */
function getHandlers(eventHandlerMap, node) {
  let handlerAndListener = eventHandlerMap.get(node);
  if (!handlerAndListener) {
    /** @type {Record<string, (event: Event) => void>} */
    const handlers = {};
    /** @param {Event} event */
    const listener = function (event) {
      handlers[event.type]?.(event);
    };
    handlerAndListener = { listener, handlers };
    eventHandlerMap.set(node, handlerAndListener);
  }
  return handlerAndListener;
}

export class TemplateView {
  /**
   * @param {PopulatedTemplate} template
   * @param {Hole[]} holes
   * @param {Record<string, Node>} refs
   * @param {TopLevelElement[]} topLevelElements
   * @param {EventHandlersMap} eventHandlersMap
   */
  constructor(template, holes, refs, topLevelElements, eventHandlersMap) {
    this.topLevelElements = topLevelElements;
    this.template = template;
    this.holes = holes;
    this.refs = refs;
    /**
     * Event handlers (especially if they need to capture local variables) end
     * up be re-created every update. Rather than add/remove handlers every
     * time, we have a "generic" handler, an then this map that we update to
     * avoid having to update the DOM
     */
    this.eventHandlersMap = eventHandlersMap;
  }

  /**
   * @param {unknown} value
   * @returns {value is PopulatedTemplate}
   */
  static isValue(value) {
    return value instanceof PopulatedTemplate;
  }

  /**
   * Render the template into the DOM.
   *
   * @param {PopulatedTemplate} populatedTemplate
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static render(populatedTemplate, parentNode, referenceNode = null) {
    const { templateKey, values } = populatedTemplate;
    const template = getTemplate(templateKey, values);
    // Clone elements from the template, then convert the template anchors to anchors by finding all the associated elements
    const clonedNodes = /** @type {DocumentFragment} */ (
      template.fragment.cloneNode(true)
    );

    // Make a list of the top-level elements in this template. We're starting
    // with the top-level nodes from the fragment, but some of these may be
    // placeholders for an element hole. So below when handling our element
    // holes, we need to swap the placeholder's TopLevelStaticNode with
    // a TopLevelHole entry
    /** @type {TopLevelElement[]} */
    const topLevelElements = [];
    for (const node of Array.from(clonedNodes.childNodes)) {
      topLevelElements.push({
        type: "static",
        node,
      });
    }

    /** @type {Record<string, Element>} */
    const refsToRemove = {};

    /** @type {EventHandlersMap} */
    const eventHandlersMap = new Map();

    /** @type {Record<string, Node>} */
    const refs = {};
    for (const ref of template.refs) {
      // TODO we could abstract most of this out here
      const anchorNode = clonedNodes.querySelector(
        `[data-template-ref="${ref.dataTemplateRef}"]`
      );
      if (!anchorNode) {
        throw new Error(
          `Anchor node not found for template ref: ${ref.dataTemplateRef}`
        );
      }
      refsToRemove[ref.dataTemplateRef] = anchorNode;
      refs[ref.name] = anchorNode;
    }

    /** @type {Hole[]} */
    const holes = template.holes.map((hole) => {
      // TODO is anchorNode really the right name here? it's the actual node not really an anchor
      const anchorNode = clonedNodes.querySelector(
        `[data-template-ref="${hole.dataTemplateRef}"]`
      );
      if (!anchorNode) {
        throw new Error(
          `Anchor node not found for template ref: ${hole.dataTemplateRef}`
        );
      }
      const anchorParentNode = /** @type {ParentNode} */ (
        anchorNode?.parentNode
      );
      const value = values[hole.index];
      const index = hole.index;

      switch (hole.type) {
        case "attribute": {
          // remove data-template-ref attribute, we don't need it as we're keeping a reference to the element itself
          refsToRemove[hole.dataTemplateRef] = anchorNode;
          if (hole.direct) {
            // @ts-ignore We're trusting the user knows what they are doing
            anchorNode[hole.name] = value;
          } else {
            const handlers = getHandlers(eventHandlersMap, anchorNode);
            updateAttribute(anchorNode, handlers, hole.name, undefined, value);
          }
          return {
            type: "attribute",
            index,
            direct: hole.direct,
            name: hole.name,
            node: anchorNode,
          };
        }
        case "attribute-splat": {
          if (typeof value !== "object") {
            throw new Error(`Invalid attribute splat value: ${value}`);
          }
          refsToRemove[hole.dataTemplateRef] = anchorNode;
          const handlers = getHandlers(eventHandlersMap, anchorNode);
          for (const [name, attributeValue] of Object.entries(value || {})) {
            if (hole.direct) {
              // @ts-ignore We're trusting the user knows what they are doing
              anchorNode[name] = attributeValue;
            } else {
              updateAttribute(
                anchorNode,
                handlers,
                name,
                undefined,
                attributeValue
              );
            }
          }
          return {
            type: "attribute-splat",
            index,
            direct: hole.direct,
            node: anchorNode,
          };
        }
        case "element": {
          // We're replacing the dummy element with a comment (we can't query for a comment, but now we have a reference to it)
          const renderedView = RenderedView.render(
            // we can't be sure what the type is, but
            // render will error if it can't handle it
            /** @type {Renderable} */ (value),
            anchorParentNode,
            anchorNode
          );

          // Replace our placeholders for element holes in our topLevelElements
          // with a reference to the view we rendered in that hole
          const topLevelIndex = topLevelElements.findIndex(
            (e) => e.type === "static" && e.node === anchorNode
          );
          if (topLevelIndex !== -1) {
            topLevelElements[topLevelIndex] = {
              type: "hole",
              renderedView,
            };
          }
          // we don't need the anchor node anymore
          anchorNode.remove();

          /** @type {ElementHole} */
          const newHole = {
            type: "element",
            index,
            renderedView,
          };
          return newHole;
        }
      }
    });

    // Clean up attributes used to find elements in the fragment
    Object.values(refsToRemove).forEach((node) => {
      node.removeAttribute("data-template-ref");
    });

    if (topLevelElements.length == 0) {
      // If topLevelElements is empty (I think this can only happen if template is empty, i.e. html``)
      //  create a dummy comment node, as each view must have a presence in the DOM
      const dummy = document.createComment("");
      topLevelElements.push({
        type: "static",
        node: dummy,
      });
      parentNode.insertBefore(dummy, referenceNode);
    } else {
      parentNode.insertBefore(clonedNodes, referenceNode);
    }

    return new TemplateView(
      populatedTemplate,
      holes,
      refs,
      topLevelElements,
      eventHandlersMap
    );
  }

  /**
   * Update the template with new values.
   *
   * @param {PopulatedTemplate} populatedTemplate
   */
  update(populatedTemplate) {
    if (populatedTemplate === this.template) {
      // this template is identical, so we don't need to do anything
      return true;
    }
    const { values, templateKey } = populatedTemplate;
    if (templateKey !== this.template.templateKey) {
      // If the template keys don't match, we can't update, need to re-render
      return false;
    }

    this.holes.forEach((hole) => {
      const newValue = values[hole.index];
      switch (hole.type) {
        case "attribute": {
          if (hole.direct) {
            // @ts-ignore We're trusting the user knows what they are doing
            hole.node[hole.name] = newValue;
            break;
          }
          const handlers = getHandlers(this.eventHandlersMap, hole.node);
          updateAttribute(
            hole.node,
            handlers,
            hole.name,
            this.template.values[hole.index],
            newValue
          );
          break;
        }
        case "attribute-splat": {
          if (hole.direct) {
            for (const name of Object.keys(
              /** @type {Record<string, unknown>} */ (newValue)
            )) {
              // @ts-ignore We're trusting the user knows what they are doing
              hole.node[name] = newValue[name];
            }
            break;
          }
          const handlers = getHandlers(this.eventHandlersMap, hole.node);
          const oldSplat = {
            .../** @type {Record<string, unknown>} */ (
              this.template.values[hole.index]
            ),
          };
          const newSplat = /** @type {Record<string, unknown>} */ (newValue);
          for (const name of new Set([
            ...Object.keys(oldSplat),
            ...Object.keys(newSplat),
          ])) {
            updateAttribute(
              hole.node,
              handlers,
              name,
              oldSplat[name],
              newSplat[name]
            );
          }

          break;
        }
        case "element": {
          // we can't be sure what the type is here, but `update` will error if
          // it can't handle it
          hole.renderedView.update(/** @type {Renderable} */ (newValue));
          break;
        }
      }
    });

    // Mostly for the values, but also for identity checking
    this.template = populatedTemplate;
    return true;
  }

  getNodes() {
    /** @type {Node[]} */
    const nodes = [];
    for (const e of this.topLevelElements) {
      if (e.type === "static") {
        nodes.push(e.node);
      } else {
        nodes.push(...e.renderedView.getNodes());
      }
    }
    return nodes;
  }

  getRefs() {
    return this.refs;
  }
}

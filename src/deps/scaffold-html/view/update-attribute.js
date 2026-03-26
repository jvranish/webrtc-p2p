/**
 * @typedef {| {
 *       [K in keyof CSSStyleDeclaration]?: CSSStyleDeclaration[K] | null;
 *     }
 *   | string
 *   | null
 *   | undefined} CSSStyleValue
 */

/**
 * @param {HTMLElement | SVGElement} node
 * @param {CSSStyleValue} oldValue
 * @param {CSSStyleValue} newValue
 */
const patchStyle = (node, oldValue, newValue) => {
  if (typeof newValue === "string") {
    node.style.cssText = newValue;
  } else {
    if (typeof oldValue === "string") {
      node.style.cssText = "";
      oldValue = {};
    }

    oldValue = oldValue || {};
    newValue = newValue || {};

    for (const k in { ...oldValue, ...newValue }) {
      const next = newValue?.[k] ?? "";
      if (k[0] === "-") {
        node.style.setProperty(k, next);
      } else {
        node.style[k] = next;
      }
    }
  }
};

/** @typedef {string | string[] | Record<string, boolean> | null | undefined} ClassValue */

/**
 * Normalize a class value to a set of class names.
 *
 * @param {ClassValue} value
 * @returns {Set<string>}
 */
const normalizeClasses = (value) => {
  const classes = new Set();
  if (!value) {
    return classes;
  }
  if (typeof value === "string") {
    value
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => classes.add(c));
  } else if (Array.isArray(value)) {
    value.forEach((c) => {
      if (typeof c === "string") {
        c.split(/\s+/)
          .filter(Boolean)
          .forEach((cls) => classes.add(cls));
      }
    });
  } else if (typeof value === "object") {
    Object.entries(value).forEach(([cls, enabled]) => {
      if (enabled) {
        classes.add(cls);
      }
    });
  }
  return classes;
};

/**
 * Patch classes on a DOM element.
 *
 * @param {Element} node
 * @param {ClassValue} oldValue
 * @param {ClassValue} newValue
 */
const patchClass = (node, oldValue, newValue) => {
  const oldClasses = normalizeClasses(oldValue);
  const newClasses = normalizeClasses(newValue);

  // Remove classes that are no longer present
  for (const cls of oldClasses) {
    if (!newClasses.has(cls)) {
      node.classList.remove(cls);
    }
  }

  // Add new classes
  for (const cls of newClasses) {
    if (!oldClasses.has(cls)) {
      node.classList.add(cls);
    }
  }
};

/**
 * Patch event handlers on a DOM element.
 *
 * @param {Node} node
 * @param {{
 *   listener: (event: Event) => void;
 *   handlers: Record<string, (event: Event) => void>;
 * }} eventHandlers
 * @param {string} name
 * @param {unknown} oldValue
 * @param {unknown} value
 */
const patchEventHandler = (
  node,
  { listener, handlers },
  name,
  oldValue,
  value
) => {
  const eventName = name.slice(2);
  if (value && typeof value !== "function") {
    throw new Error(`Invalid event handler for ${eventName}: ${value}`);
  }
  if (value) {
    handlers[eventName] = /** @type {(event: Event) => void} */ (value);
  }
  if (value && !oldValue) {
    // we didn't have a handler before so we need to add our listener
    node.addEventListener(eventName, listener);
  } else if (!value && oldValue) {
    // we used to have a handler, so we need to remove our listener
    delete handlers[eventName];
    node.removeEventListener(eventName, listener);
  }
};

/**
 * Update the value of an attribute on a DOM element.
 *
 * @param {Node} node
 * @param {{
 *   listener: (event: Event) => void;
 *   handlers: Record<string, (event: Event) => void>;
 * }} eventHandlers
 * @param {string} name
 * @param {unknown} oldValue
 * @param {unknown} value
 */
export function updateAttribute(node, eventHandlers, name, oldValue, value) {
  if (value === oldValue) {
    return;
  }

  if (name.startsWith("on")) {
    patchEventHandler(node, eventHandlers, name, oldValue, value);
  } else if (node instanceof Element) {
    if (
      name === "style" &&
      (node instanceof HTMLElement || node instanceof SVGElement)
    ) {
      if (typeof value !== "object" && typeof value !== "string") {
        throw new Error(`Invalid style value for ${name}: ${value}`);
      }
      patchStyle(node, /** @type {CSSStyleValue} */ (oldValue), value);
    } else if (name === "class") {
      patchClass(
        node,
        /** @type {ClassValue} */ (oldValue),
        /** @type {ClassValue} */ (value)
      );
    } else if (
      !(node instanceof SVGElement) &&
      name in node &&
      name !== "href" &&
      name !== "list" &&
      name !== "form" &&
      // Default value in browsers is `-1` and an empty string is
      // cast to `0` instead
      name !== "tabIndex" &&
      name !== "download"
    ) {
      // This is a cursed heuristic, (this particular hack borrowed from preact)
      // it's here to work around this problem:
      // checkbox.setAttribute("checked", ""); // <-- checks a checkbox
      // checkbox.removeAttribute("checked"); // <-- unchecks a checkbox
      // // *user clicks on checkbox, it's now checked*
      // checkbox.removeAttribute("checked"); // <-- does nothing
      // // *user clicks on checkbox, it's now unchecked*
      // checkbox.setAttribute("checked", ""); // <-- also does nothing
      // checkbox.checked = true; // <-- checks checkbox
      // checkbox.checked = false; // <-- unchecks checkbox

      // To avoid this problem, we check if the attribute is a property on our
      // DOM node i.e. `name in node`, if it is, then we set the value directly
      // rather than via attribute.

      // However _that_ behavior apparently doesn't work nicely with the above
      // exception attributes. (I didn't explore too deeply there, but I already
      // got burned by thinking I could improve on this heuristic, so I'm going
      // to give up and trust in the ancients) (There's a good overview on
      // attributes vs properties here:
      // https://jakearchibald.com/2024/attributes-vs-properties/)

      // If one wants to set an actual `null` instead of "", you can use a
      // direct attribute i.e. `<foo .thing=${null}>`, which always only sets
      // the property directly

      // @ts-ignore this is already cursed
      node[name] = value == null ? "" : value;
    } else if (value == null || value === false) {
      node.removeAttribute(name);
    } else if (typeof value === "boolean") {
      // `value` must be true here
      node.setAttribute(name, "");
    } else if (typeof value === "string" || typeof value === "number") {
      node.setAttribute(name, String(value));
    } else {
      throw new Error(
        `Unexpected type ${typeof value} for attribute: ${name} on ${node}`
      );
    }
  }
}

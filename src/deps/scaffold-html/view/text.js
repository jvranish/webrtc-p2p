
export class TextView {
  /**
   * @param {Node} node
   * @param {string} text
   */
  constructor(node, text) {
    this.node = node;
    this.text = text;
  }

  /**
   * @param {unknown} value
   * @returns {value is string | number}
   */
  static isValue(value) {
    return typeof value === "string" || typeof value === "number";
  }

  /**
   * @param {string | number} text
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static render(text, parentNode, referenceNode = null) {
    const textStr = String(text);
    const node = document.createTextNode(textStr);
    const view = new TextView(node, textStr);
    parentNode.insertBefore(node, referenceNode);
    return view;
  }

  /**
   * Update the text content of the node.
   *
   * @param {string | number} newText
   */
  update(newText) {
    const text = String(newText);
    if (this.text !== text) {
      this.text = text;
      this.node.textContent = this.text;
    }
    return true;
  }

  getNodes() {
    return [this.node];
  }
}

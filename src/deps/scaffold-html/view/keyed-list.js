import { RenderedView } from "./index.js";
/** @import {Renderable} from "./view-types.js" */

export class KeyedListView {
  /**
   * @param {{ key: unknown; value: RenderedView }[]} viewsWithKey
   * @param {Node} anchorNode
   */
  constructor(viewsWithKey, anchorNode) {
    this.existingMap = new Map(
      viewsWithKey.map(({ key, value }, index) => [key, { value, index }])
    );

    // Check for duplicate keys
    if (viewsWithKey.length !== this.existingMap.size) {
      // Find the duplicate key(s)
      const seen = new Set();
      /** @type {unknown[]} */
      const duplicates = [];
      for (const { key } of viewsWithKey) {
        if (seen.has(key)) {
          if (!duplicates.includes(key)) {
            duplicates.push(key);
          }
        }
        seen.add(key);
      }
      throw new Error(
        `Duplicate key(s) found in keyed list: ${duplicates.join(", ")}`
      );
    }

    this.existingValues = viewsWithKey;
    this.anchorNode = anchorNode;
  }

  /**
   * @param {unknown} value
   * @returns {value is {key: unknown, value: Renderable}[]}
   */
  static isValue(value) {
    return (
      Array.isArray(value) &&
      (value.length === 0 ||
        (typeof value[0] === "object" &&
          value[0] !== null &&
          "key" in value[0]))
    );
  }

  /**
   * Render the keyed list into the DOM.
   *
   * @param {{ key: unknown; value: Renderable }[]} values
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static render(values, parentNode, referenceNode) {
    /** @type {{ key: unknown; value: RenderedView }[]} */
    const viewsWithKey = values.map(({ key, value }) => ({
      key,
      value: RenderedView.render(value, parentNode, referenceNode),
    }));
    // We have a rule that every view must _always_ have some node in the DOM.
    // Since lists can be empty we leave a comment after the list so we don't
    // have to worry about it. Without the "must always have at least one node"
    // rule, we'd need parentNode and referenceNode passed to update, which
    // would significantly complicate things.
    const anchorNode = document.createComment("");
    parentNode.insertBefore(anchorNode, referenceNode);
    return new KeyedListView(viewsWithKey, anchorNode);
  }

  /**
   * Update the keyed list with new values.
   *
   * @param {{ key: unknown; value: Renderable }[]} desiredValues
   */
  update(desiredValues) {
    const parentNode = this.anchorNode.parentNode;
    if (!parentNode) {
      return false;
    }

    // Make map of new desiredValues, this is used to quickly tell if an old value is
    // still in the new list
    const map = new Map(
      desiredValues.map(({ key, value }, index) => [key, { value, index }])
    );

    // There is a case where we can move an element further down in `this.value`
    // to an earlier position. When we do this we will end up walking over this
    // element later, so we add it to this set to avoid processing it again.
    /** @type {Set<number>} */
    const moved = new Set();

    let frontExisting = 0;
    let frontDesired = 0;

    /** @type {{ key: unknown; value: RenderedView }[]} */
    const newValues = [];
    /** @type {Map<unknown, { index: number; value: RenderedView }>} */
    const newMap = new Map();

    // You can tell already this is going to get dicey
    while (true) {
      // This is by far the most complicated algorithm in the whole library. The
      // final order of elements must match the ones in `desiredValues`, however often
      // we're just adding a new element or two, or updating or swapping
      // existing elements, so in order to avoid re-rendering the whole list in
      // these cases we need to iterate through both lists at the same time.

      // `desiredValues` defines what the final thing should look like,
      // but operations need to be performed at the corresponding position in
      // `this.existingValues`

      const desiredValue = desiredValues.at(frontDesired);
      const existingValue = this.existingValues.at(frontExisting);

      if (!desiredValue && !existingValue) {
        // We're done!
        break;
      }

      if (moved.has(frontExisting)) {
        // This is an element we've already moved to an earlier position so we
        // need to skip it
        frontExisting++;
        continue;
      }

      if (!desiredValue) {
        // We have no more new `desiredValues`, any remaining old `existingValues` need to be removed
        // typescript isn't smart enough to tell, but existingValue can't be falsy here
        existingValue?.value.remove();
        frontExisting++;
        continue;
      }

      const existingByDesiredKey = this.existingMap.get(desiredValue.key);

      if (!existingByDesiredKey) {
        // This desiredValue isn't in the existing list, so insert it at present position
        const anchor = existingValue?.value.referenceNode() || this.anchorNode;
        const value = RenderedView.render(
          desiredValue.value,
          parentNode,
          anchor
        );
        newMap.set(desiredValue.key, { value, index: newValues.length });
        newValues.push({ key: desiredValue.key, value });
        frontDesired++;
        continue;
      }

      if (existingValue) {
        const desiredByExistingKey = map.get(existingValue.key);

        if (!desiredByExistingKey) {
          // If existing value isn't in the desired list remove it.
          existingValue.value.remove();
          frontExisting++;
          continue;
        }

        if (existingValue.key == desiredValue.key) {
          // We have a matching element! update it
          existingValue.value.update(desiredValue.value);
          newMap.set(desiredValue.key, {
            value: existingValue.value,
            index: newValues.length,
          });
          newValues.push(existingValue);
          frontDesired++;
          frontExisting++;
          continue;
        }

        // We have an existingValue and a desiredValue, but their keys don't
        // match but both are going to end up in the final list. We can either
        // move the one that's supposed to be here, up, _or_ we can skip all
        // existing values until we reach right one. We know those skipped
        // values exist in our remaining desiredValues list, so those will be
        // covered in our "move" case in future iterations and will be moved
        // down later.

        // Do we move the desired one up, or the existing one down? We don't
        // really have any idea what is optimal here, so we use a _very_ rough
        // heuristic: if the desired position for this existing element, is more
        // than half-way through the rest of the desired list, then we skip

        // The algorithm will still produce correct results without this,
        // however this heuristic avoids some worse-case performance cases. For
        // example, without it, swapping an a element at the end of the list
        // with one at the front, would cause us to move up every single
        // existing element in front of the existing element that was swapped to
        // the bottom, one at a time. This is a case where "moving down"
        // (skipping) is enormously faster if the list is big.
        const remaining = desiredValues.length - frontDesired;
        const distance = desiredByExistingKey.index - frontDesired;
        if (distance > remaining / 2) {
          frontExisting++;
          continue;
        }
      }

      // Move existing element to new position, and update
      const anchor = existingValue?.value.referenceNode() || this.anchorNode;
      existingByDesiredKey.value.insertBefore(anchor);
      existingByDesiredKey.value.update(desiredValue.value);
      newMap.set(desiredValue.key, {
        value: existingByDesiredKey.value,
        index: newValues.length,
      });
      newValues.push({
        key: desiredValue.key,
        value: existingByDesiredKey.value,
      });
      // Mark that we've moved this one so we don't try to process it again
      moved.add(existingByDesiredKey.index);
      frontDesired++;
    }

    this.existingValues = newValues;
    this.existingMap = newMap;

    return true;
  }

  /** @returns {Node[]} */
  getNodes() {
    return Array.from(this.existingMap
      .values())
      .flatMap((renderedView) => renderedView.value.getNodes());
  }
}

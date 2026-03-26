import { PopulatedTemplate } from "./template/template-builder.js";
import { ComponentInstance } from "./component.js";
import { View } from "./index.js";

// This should be something like below, but it complains about circular references
// export type Renderable = Parameters<View["update"]>[0];
export type Renderable =
  | string
  | number
  | PopulatedTemplate
  | { key: unknown; value: Renderable }[]
  | Renderable[]
  // deno-lint-ignore no-explicit-any
  | ComponentInstance<any, any, Record<string, typeof HTMLElement>>;

export interface ViewInstance<T> {
  // Updates view with new value, returning false forces a re-render.
  // If possible, view should skip updating if it's able to tell that the
  // value it got was identical to the last value it got.
  update(value: T): boolean;
  // Returns only the top-level nodes in the view. Must always have at least one node.
  getNodes(): Node[];
}

export interface ViewClass<T> {
  // deno-lint-ignore no-explicit-any
  new (...args: any[]): ViewInstance<T>;
  // Checks if the value is handled by this type of view
  isValue(value: unknown): value is T;
  // Constructs a new view, renders it into the DOM, and return the new view
  render(
    value: T,
    parentNode: Node,
    referenceNode: Node | null
  ): View & ViewInstance<T>;
}

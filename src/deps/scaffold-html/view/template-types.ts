import { RenderedView } from "./index.js";

export type AttributeHole = {
  type: "attribute";
  node: Node;
  index: number;
  name: string;
  direct: boolean;
};

export type AttributeSplatHole = {
  type: "attribute-splat";
  node: Node;
  index: number;
  direct: boolean;
};

export type ElementHole = {
  type: "element";
  index: number;
  renderedView: RenderedView;
};

export type Hole = AttributeHole | AttributeSplatHole | ElementHole;

export type TopLevelStaticNode = {
  type: "static";
  node: Node;
}

export type TopLevelHole = {
  type: "hole"
  renderedView: RenderedView;
}

export type TopLevelElement = TopLevelStaticNode | TopLevelHole;
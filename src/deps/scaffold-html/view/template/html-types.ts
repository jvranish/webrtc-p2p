export type AttributeLiteralValue = {
  type: "literal";
  name: string;
  value: string | boolean;
  direct: boolean;
};

export type AttributeRef = {
  type: "ref";
  name: string;
};

export type AttributeHole = {
  type: "attribute-hole";
  index: number;
  name: string;
  value: unknown;
  direct: boolean;
};

export type AttributeSplatHole = {
  type: "attribute-splat-hole";
  index: number;
  props: unknown;
  direct: boolean;
};

export type Attribute =
  | AttributeLiteralValue
  | AttributeRef
  | AttributeHole
  | AttributeSplatHole;

export type TagNode = {
  type: "tag";
  name: string;
  attributes: Attribute[];
  childNodes: AstNode[];
};

export type TextNode = { type: "text"; value: string };

export type CommentNode = { type: "comment"; comment: string[] };

export type ElementHole = {
  type: "element-hole";
  index: number;
  value: unknown;
};

export type AstNode = TagNode | TextNode | ElementHole | CommentNode;

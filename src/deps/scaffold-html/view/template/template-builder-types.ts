
export type TemplateAttributeHole = {
  type: "attribute";
  name: string;
  index: number;
  dataTemplateRef: string;
  direct: boolean;
};

export type TemplateElementRef = {
  name: string;
  dataTemplateRef: string;
};

export type TemplateAttributeSplatHole = {
  type: "attribute-splat";
  index: number;
  dataTemplateRef: string;
  direct: boolean;
};

export type TemplateElementHole = {
  type: "element";
  index: number;
  dataTemplateRef: string;
};

export type TemplateHole =
  | TemplateAttributeHole
  | TemplateAttributeSplatHole
  | TemplateElementHole;


export type Template = {
  templateKey: TemplateStringsArray;
  fragment: DocumentFragment;
  holes: TemplateHole[];
  refs: TemplateElementRef[];
};

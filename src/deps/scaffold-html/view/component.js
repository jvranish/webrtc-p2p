import { RenderedView } from "./index.js";
import { TemplateView } from "./template.js";
/** @import {Renderable} from "./view-types.js" */

/**
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {{ [K in keyof R]: InstanceType<R[K]> }} RefInstanceMap
 */

/**
 * @template S
 * @template P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {{
 *   state: S;
 *   prevProps: P;
 *   update: (f: (state: S) => S | void) => void;
 *   readonly refs: RefInstanceMap<R>;
 * }} ComponentContext
 */

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {{
 *   render: (this: ComponentContext<S, P, R>, props: P) => Renderable;
 *   init?: (props: P) => S;
 *   refs?: R;
 * }} ComponentDefinition
 */



// In order to pass props to the "component", no matter how I slice it I have to
//  pass both the "definition" and the props, as separate things. like [Foo,
//  {props}] This `ComponentInstance` class is just a container for these two parts, the
//  `ComponentDefinition` and the props
/**
 * @template S [S={}]
 * @template P [P={}]
 * @template {Record<string, typeof HTMLElement>} R [R={}]
 */
export class ComponentInstance {
  /**
   * @param {ComponentDefinition<S, P, R>} def
   * @param {P} props
   */
  constructor(def, props) {
    const { render, init, refs } = def;
    this.def = def;
    /** @type (props: P) => S */
    const emptyInit = () => /** @type {S} */ ({});
    this.render = render;
    this.init = init ? init : emptyInit;
    this.refs = refs || /** @type {R} */ ({});
    this.props = props;
  }
}

/**
 * @template S, P
 * @template {Record<string, typeof HTMLElement>} R
 * @typedef {(props?: P) => ComponentInstance<S, P, R>} Component
 */

/**
 * @template [S={}] Default is `{}`
 * @template [P={}] Default is `{}`
 * @template {Record<string, typeof HTMLElement>} [R={}] Default is `{}`
 * @param {ComponentDefinition<S, P, R>} def
 * @returns {(props?: P) => ComponentInstance<S, P, R>}
 */
export function asComponent(def) {
  return (props) =>
    new ComponentInstance(def, props || /** @type {P} */ ({}));
}


export class ComponentView {
  /**
   * @param {ComponentInstance<
   *   unknown,
   *   unknown,
   *   Record<string, typeof HTMLElement>
   * >} component
   * @param {ComponentContext<
   *   unknown,
   *   unknown,
   *   Record<string, typeof HTMLElement>
   * >} context
   * @param {RenderedView} renderedView
   */
  constructor(component, context, renderedView) {
    this.component = component;
    this.renderedView = renderedView;
    this.context = context;
  }

  /**
   * @param {unknown} value
   * @returns {value is ComponentInstance<unknown, unknown, Record<string, typeof HTMLElement>>}
   */
  static isValue(value) {
    return value instanceof ComponentInstance;
  }

  /**
   * @param {ComponentInstance<
   *   unknown,
   *   unknown,
   *   Record<string, typeof HTMLElement>
   * >} component
   * @param {Node} parentNode
   * @param {Node | null} referenceNode
   */
  static render(component, parentNode, referenceNode) {
    /** @type {ComponentView} */
    // deno-lint-ignore prefer-const
    let newView;

    /** @param {(state: unknown) => unknown | void} f */
    const update = (f) => {
      const s = f(context.state);
      if (s !== undefined) {
        context.state = s;
      }
      // TODO is this really the best way to do this?
      component.props = context.prevProps;
      // you are not allowed to call update directly in component.f, component.f must return first
      newView.update(component);
    };

    /**
     * @type {ComponentContext<
     *   unknown,
     *   unknown,
     *   Record<string, typeof HTMLElement>
     * >}
     */
    const context = {
      state: component.init(component.props),
      prevProps: component.props,
      update,
      /** @returns {{}} */
      get refs() {
        throw new Error(
          "You can't access `refs` synchronously in a component's first render as they don't exist yet.",
        );
      },
    };
    const value = component.render.call(context, component.props);
    const renderedView = RenderedView.render(value, parentNode, referenceNode);
    newView = new ComponentView(component, context, renderedView);
    // the `refs` field of the context will be updated after `render` returns
    newView.updateContext(component.props);
    return newView;
  }

  /** @param {unknown} props */
  updateContext(props) {
    this.context.prevProps = props;
    const renderedView = this.renderedView;
    const refs = this.component.refs;

    Object.defineProperty(this.context, "refs", {
      get() {
        if (renderedView.view instanceof TemplateView) {
          const viewRefs = renderedView.view.getRefs();
          for (const [name, elementType] of Object.entries(refs)) {
            if (name in viewRefs) {
              if (!(viewRefs[name] instanceof elementType)) {
                throw Error(`Expected ref ${name}, to have type ${elementType.name}, but it was ${viewRefs[name].constructor.name}`)
              }
            } else {
              throw Error(`Expected to have a ref name ${name} in template, but did not find it`);
            }
          }
          return viewRefs;
        } else {
          return {};
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * @param {ComponentInstance<
   *   unknown,
   *   unknown,
   *   Record<string, typeof HTMLElement>
   * >} component
   */
  update(component) {
    if (component.def !== this.component.def) {
      // If the definition of the component changed, we need to reset the state
      // and context, returning a false here forces us to get re-rendered
      return false;
    }
    const newValue = component.render.call(this.context, component.props);
    this.renderedView.update(newValue);
    this.updateContext(component.props);
    return true;
  }

  /** @returns {Node[]} */
  getNodes() {
    return this.renderedView.getNodes();
  }
}

# scaffold-html

A minimal html rendering library using tagged template literals for declarative UI rendering with surgical DOM updates.

I wanted something that would give all the nice features of tools like react, but didn't require any build step to use, and was simple and readable. I feel like I partially failed on the "simple" 😅 but it's not too bad.

It's very similar to other minimalist frameworks like uhtml or hyperapp, but, I think, has a fairly unique internal architecture.
It's _kinda_ like a VDOM framework, but essentially only keeps "nodes" at the template level. The only "diffing" that's done is with keyed lists and dynamic attribute values. Static elements add essentially no overhead.

I make this purely for myself for fun. I use it in some of my personal projects, but it definitely hasn't been stress tested. It should mostly work, but don't be surprised if you find a dumb bug or two. I have no ambitions to see it more widely used, but I thought it was interesting enough to share!

AI use: Essentially all of the core logic was written by hand. But much of the tests and documentation was written by Claude.

## Basic Usage

```javascript
import { html, render } from "scaffold-html";

// Define a component as a function that returns a template
const App = (count) => html`
  <div>
    <h1>Count: ${count}</h1>
    <button onclick=${() => update(count + 1)}>Increment</button>
  </div>
`;

// Initial render
const view = render(App(0), document.body);

// Update function
const update = (newCount) => view.update(App(newCount));
```

## SVG Support

Use the `svg` tagged template for creating SVG elements:

```javascript
import { html, svg, render } from "scaffold-html";

// Create SVG templates with the svg tag
const Circle = (radius, color) => svg`
  <svg width="200" height="200" viewBox="0 0 200 200">
    <circle cx="100" cy="100" r=${radius} fill=${color} />
  </svg>
`;

// SVG templates can be nested in HTML templates
const App = () => html`
  <div>
    <h1>My SVG</h1>
    ${Circle(50, "blue")}
  </div>
`;

render(App(), document.body);
```

**Note:** SVG elements must use the `svg` tagged template (not `html`). This ensures proper namespace handling for SVG elements.

## Development

### Running the Demo

Start a local web server in the repo root:

```bash
python -m http.server 5500
# or
npx http-server -p 5500
```

Then open [http://localhost:5500/example/](http://localhost:5500/example)

### Running Tests

Or open [http://localhost:5500/tests/](http://localhost:5500/tests/) in your browser.

# Templates

## Template Holes

Templates accepts different types of values in their holes depending on context:

### Attribute Value Holes

Attribute value holes generally accept string, number or bools, but there is special handling for class, style, and event handler attributes:

```javascript
// String, number, or boolean values
html`<div class=${"foo bar"} tabindex=${0} disabled=${true}>...</div>`;

// class attribute - accepts strings, arrays, or objects
html`<div class=${"foo bar"}>...</div>`;
html`<div class=${["foo", "bar"]}>...</div>`;
html`<div class=${{ foo: true, bar: false }}>...</div>`; // class="foo"

// style attribute - accepts strings or objects
html`<div style="color: red">...</div>`;
html`<div style=${{ color: "red", fontSize: "16px" }}>...</div>`;

// event handlers (on* attributes)
html`<button onclick=${(e) => console.log("clicked")}>Click</button>`;
```

### Attribute Splat Holes

```javascript
// Spread multiple attributes from an object
const attrs = { class: "btn", disabled: true, onclick: handleClick };
html`<button ${attrs}>Click</button>`;

// Direct property assignment (use .prop or ...prop syntax)
// Sets element properties directly instead of attributes
// Generally avoid unless setting non-string properties on custom elements
html`<my-custom-element .foo=${{ complex: "object" }}>...</my-custom-element>`;
html`<my-custom-element ...${{ foo: "bar", baz: 42 }}>...</my-custom-element>`;
```

### Element Holes

Element holes accept any `Renderable`:

```javascript
// Strings or numbers (rendered as text)
html`<div>${"Hello"} ${123}</div>`;

// Another template (nested templates)
html`<div>${html`<span>Nested</span>`}</div>`;

// Array of Renderables (use keyed lists when items can reorder)
html`<ul>${items.map(item => html`<li>${item}</li>`)}</ul>`;

// Keyed list - {key: unknown, value: Renderable}[]
// Keys can be any valid Map key
const items = [{id: 1, text: "Foo"}, {id: 2, text: "Bar"}];
html`
  <ul>
    ${items.map(item => ({ key: item.id, value: html`<li>${item.text}</li>` }))}
  </ul>
`;

// Component instances (see COMPONENTS.md)
html`<div>${MyComponent({ prop: "value" })}</div>`;
```

## Performance

- No traditional DOM diffing
- Static elements have no additional performance cost
- Attributes set to the same value don't trigger DOM updates (except direct properties which always update)
- Replacing event handlers doesn't trigger DOM updates

**Important:** For elements to update in place (rather than be removed and re-rendered), they must come from the same template. The `html` tagged template must be the same reference.

```javascript
// ❌ Wrong - these are two separate templates
const initial = html`<div class=${"foo"}>Content</div>`;
const updated = html`<div class=${"bar"}>Content</div>`;
const view = render(initial, document.body);
view.update(updated);

// ✅ Correct - reuses same template structure
const Foo = (className) => html`<div class=${className}>Content</div>`;
const view = render(Foo("foo"), document.body);
view.update(Foo("bar"));
```

## API

### `html`
```typescript
html(strings: TemplateStringsArray, ...values: unknown[]): PopulatedTemplate
```
Tagged template literal that creates an HTML template.

### `svg`
```typescript
svg(strings: TemplateStringsArray, ...values: unknown[]): PopulatedTemplate
```
Tagged template literal that creates an SVG template. Use this for all SVG elements to ensure proper namespace handling.

### `render`
```typescript
render(value: Renderable, parentNode: Node, referenceNode?: Node | null): RenderedView
```
Renders a value into the DOM.

### `RenderedView.update`
```typescript
update(newValue: Renderable): void
```
Updates the rendered content.

## Examples

See [example/index.html](example/index.html) for an example TODO app.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Deep dive into implementation
- [COMPONENTS.md](COMPONENTS.md) - Stateful component system


# Components Guide

## Overview

`asComponent` creates stateful, self-updating components. Use when you need:
- Encapsulated internal state
- DOM references to elements
- Self-contained UI behavior (collapsed/expanded, editing mode, etc.)

## Basic Usage

```javascript
import { html, render, asComponent } from "scaffold-html";

const Counter = asComponent({
  init() {
    return { count: 0 };
  },
  render() {
    return html`
      <div>
        <span>${this.state.count}</span>
        <button onclick=${() => this.update(s => s.count++)}>+</button>
      </div>
    `;
  },
});

render(Counter(), document.body);
```

## Component Definition

```typescript
{
  init?: (props) => state,           // Initialize state (optional)
  render: (props) => Renderable,     // Render function (required)
  refs?: { refName: HTMLElementType } // DOM references (optional)
}
```

## Component Context (`this`)

- `this.state` - Current state, can update directly in `render` or use `update()` to modify from outside component.
- `this.update(fn)` - Update state and re-render
- `this.prevProps` - Previous props (for change detection)
- `this.refs` - DOM element references

### State Updates

```javascript
// Mutate state
this.update(state => { state.count++; });

// Replace state
this.update(state => ({ count: state.count + 1 }));
```

**Important:** Updates are synchronous. Never call `this.update()` during render, only in event handlers.

## Props

```javascript
const Greeting = asComponent({
  /** @param {{name: string}} props */
  render(props) {
    return html`<h1>Hello, ${props.name}</h1>`;
  },
});

render(Greeting({ name: "Alice" }), container);
```

## Conditional Updates

You can optimize renders by caching templates in state when props haven't changed:

```javascript
const UserCard = asComponent({
  init(props) {
    return {
      cachedTemplate: html`
        <div class="user">
          <h3>${props.user.name}</h3>
          <p>${props.user.bio}</p>
        </div>
      `,
    };
  },
  render(props) {
    // If props have changed, create new template and cache it
    if (this.prevProps !== props) {
      this.state.cachedTemplate = html`
      <div class="user">
        <h3>${props.user.name}</h3>
        <p>${props.user.bio}</p>
      </div>
    `;
    }

    // Return cached template
    return this.state.cachedTemplate;
  },
});
```

The renderer will notice if the `PopulatedTemplate` returned by `render` is identical to the one returned previously, and will know that no further DOM updates are necessary for this component.

**Note:** This framework is already pretty smart about only updating what's necessary. You likely won't need an optimization like this unless you have a template with a _lot_ of dynamic content.

## DOM References

```javascript
const InputComponent = asComponent({
  render() {
    const focus = () => this.refs.input.focus();

    return html`
      <input #input type="text" />
      <button onclick=${focus}>Focus</button>
    `;
  },
  refs: {
    input: HTMLInputElement,
  },
});
```

**Note:** Refs are unavailable during first render, only use in event handlers.

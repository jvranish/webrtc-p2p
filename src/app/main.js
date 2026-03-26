// @ts-check

import { render } from 'scaffold-html';
import { state, setRenderCallback, scheduleRender } from './state.js';
import { App } from './components/app.js';

const appRoot = /** @type {HTMLElement} */ (document.getElementById('app'));
const view = render(App(state), appRoot);

setRenderCallback(() => {
  view.update(App(state));
});

// If the page was opened with an offer link, auto-open the join flow
const hash = location.hash;
if (hash.startsWith('#offer=')) {
  state.handleOffer(hash).catch((err) => console.error('Auto-join failed', err));
  scheduleRender();
}

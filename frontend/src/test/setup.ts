import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests. RTL's automatic afterEach(cleanup)
// does not reliably register under our vitest setup, so without this the
// DOM from earlier tests leaks into later ones (duplicate elements,
// stale dropdowns), making queries match the wrong render.
afterEach(() => {
  cleanup();
});

// jsdom implements no layout, so Element.scrollIntoView does not exist there.
// Components that keep an active item in view (the networks typeahead) call it
// on every highlight change; without this they throw in tests but work in a
// real browser.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

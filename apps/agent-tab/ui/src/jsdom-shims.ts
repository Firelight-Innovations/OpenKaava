/**
 * What assistant-ui's thread viewport needs from a browser and jsdom lacks:
 * it measures with a `ResizeObserver` and follows the newest turn with
 * `scrollTo`. Tests that render the tab import this first.
 */
import { vi } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

Element.prototype.scrollTo ??= function scrollTo() {};

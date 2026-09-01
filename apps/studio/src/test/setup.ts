import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

document.documentElement.lang = "en";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

window.matchMedia ??= (query: string) => ({
  addEventListener: () => undefined,
  addListener: () => undefined,
  dispatchEvent: () => false,
  matches: false,
  media: query,
  onchange: null,
  removeEventListener: () => undefined,
  removeListener: () => undefined,
});

afterEach(cleanup);

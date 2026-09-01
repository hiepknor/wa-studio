import { afterEach, describe, expect, it } from "vitest";

import { installFocusModality } from "./installFocusModality";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  delete document.documentElement.dataset.focusModality;
});

describe("installFocusModality", () => {
  it("shows focus for keyboard input and suppresses it before pointer focus", () => {
    dispose = installFocusModality(document);
    expect(document.documentElement).toHaveAttribute("data-focus-modality", "pointer");

    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.documentElement).toHaveAttribute("data-focus-modality", "keyboard");

    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.documentElement).toHaveAttribute("data-focus-modality", "pointer");
  });
});

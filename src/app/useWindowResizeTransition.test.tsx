import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWindowResizeTransition } from "./useWindowResizeTransition";

describe("useWindowResizeTransition", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.windowResizing;
  });

  it("marks the window as resizing until resize events settle", () => {
    vi.useFakeTimers();
    renderHook(() => useWindowResizeTransition());

    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.dataset.windowResizing).toBe("true");

    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(119);
    expect(document.documentElement.dataset.windowResizing).toBe("true");

    vi.advanceTimersByTime(1);
    expect(document.documentElement.dataset.windowResizing).toBeUndefined();
  });

  it("removes the resizing marker when unmounted", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useWindowResizeTransition());

    window.dispatchEvent(new Event("resize"));
    unmount();

    expect(document.documentElement.dataset.windowResizing).toBeUndefined();
  });
});

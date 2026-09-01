import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useLatestOperation } from "./useLatestOperation";

describe("useLatestOperation", () => {
  it("remains mounted after the StrictMode effect rehearsal", () => {
    const { result } = renderHook(() => useLatestOperation(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    const token = result.current.begin();
    expect(result.current.isCurrent(token)).toBe(true);
  });

  it("invalidates a superseded operation", () => {
    const { result } = renderHook(() => useLatestOperation());
    let first = 0;
    let second = 0;
    act(() => {
      first = result.current.begin();
      second = result.current.begin();
    });
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it("invalidates the active operation on unmount", () => {
    const { result, unmount } = renderHook(() => useLatestOperation());
    let token = 0;
    act(() => { token = result.current.begin(); });
    unmount();
    expect(result.current.isCurrent(token)).toBe(false);
  });
});

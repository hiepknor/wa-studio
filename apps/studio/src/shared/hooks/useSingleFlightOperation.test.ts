import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useSingleFlightOperation } from "./useSingleFlightOperation";

describe("useSingleFlightOperation", () => {
  it("remains mounted after the StrictMode effect rehearsal", () => {
    const { result } = renderHook(() => useSingleFlightOperation(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    const token = result.current.begin();
    expect(token).not.toBeNull();
    expect(result.current.isCurrent(token!)).toBe(true);
  });

  it("rejects overlapping work until the active token completes", () => {
    const { result } = renderHook(() => useSingleFlightOperation());
    let first: number | null = null;
    let overlapping: number | null = null;

    act(() => {
      first = result.current.begin();
      overlapping = result.current.begin();
    });

    expect(first).not.toBeNull();
    expect(overlapping).toBeNull();
    expect(result.current.isCurrent(first!)).toBe(true);
    expect(result.current.complete(first!)).toBe(true);
    expect(result.current.begin()).not.toBeNull();
  });

  it("invalidates active work on cancel and unmount", () => {
    const { result, unmount } = renderHook(() => useSingleFlightOperation());
    const cancelled = result.current.begin()!;
    act(() => result.current.cancel());
    expect(result.current.isCurrent(cancelled)).toBe(false);
    expect(result.current.complete(cancelled)).toBe(false);

    const unmounted = result.current.begin()!;
    unmount();
    expect(result.current.isCurrent(unmounted)).toBe(false);
    expect(result.current.complete(unmounted)).toBe(false);
  });
});

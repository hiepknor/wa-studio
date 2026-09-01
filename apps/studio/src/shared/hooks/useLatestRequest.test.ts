import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLatestRequest } from "./useLatestRequest";

describe("useLatestRequest", () => {
  it("aborts a superseded read and retains only the latest signal", () => {
    const { result } = renderHook(() => useLatestRequest());
    let first!: AbortSignal;
    let second!: AbortSignal;

    act(() => { first = result.current.begin(); });
    act(() => { second = result.current.begin(); });

    expect(first.aborted).toBe(true);
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
    act(() => { result.current.complete(first); });
    expect(result.current.isCurrent(second)).toBe(true);
  });

  it("aborts the active read when its owner unmounts", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    let signal!: AbortSignal;
    act(() => { signal = result.current.begin(); });

    unmount();

    expect(signal.aborted).toBe(true);
  });
});

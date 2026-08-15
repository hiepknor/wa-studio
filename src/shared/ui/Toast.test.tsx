import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./Toast";

function ToastHarness() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.notify({ title: "Saved", tone: "success" })} type="button">
        Show success
      </button>
      <button
        onClick={() => toast.notify({ id: "sync", title: "Sync started", tone: "info" })}
        type="button"
      >
        Start sync
      </button>
      <button
        onClick={() => toast.notify({ id: "sync", title: "Sync complete", tone: "success" })}
        type="button"
      >
        Complete sync
      </button>
      <button onClick={() => toast.notify({ title: "Failed", tone: "danger" })} type="button">
        Show error
      </button>
      <button
        onClick={() => {
          for (const title of ["One", "Two", "Three", "Four"]) toast.notify({ title });
        }}
        type="button"
      >
        Fill notifications
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <ToastHarness />
    </ToastProvider>,
  );
}

afterEach(() => vi.useRealTimers());

describe("ToastProvider", () => {
  it("uses shared feedback semantics and supports explicit dismissal", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Show success" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByRole("region", { name: "Notifications" }))
      .toContainElement(screen.getByText("Saved"));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });

  it("replaces a keyed toast instead of stacking duplicate lifecycle messages", () => {
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Start sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete sync" }));

    expect(screen.queryByText("Sync started")).not.toBeInTheDocument();
    expect(screen.getByText("Sync complete")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("auto-dismisses and cleans up its timer", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Show success" }));
    act(() => vi.advanceTimersByTime(4_120));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show success" }));
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("queues notifications beyond the visible stack without discarding them", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Fill notifications" }));

    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByText("Three")).toBeInTheDocument();
    expect(screen.queryByText("Four")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]);
    act(() => vi.advanceTimersByTime(120));

    expect(screen.queryByText("One")).not.toBeInTheDocument();
    expect(screen.getByText("Four")).toBeInTheDocument();
  });

  it("pauses auto-dismiss while the notification is hovered", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Show success" }));
    const toast = screen.getByRole("status");
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByText("Saved")).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(2_120));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("keeps danger notifications visible until they are dismissed", () => {
    vi.useFakeTimers();
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Show error" }));
    act(() => vi.advanceTimersByTime(60_000));

    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });
});

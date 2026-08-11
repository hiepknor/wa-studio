import { useEffect } from "react";

const RESIZE_SETTLE_DELAY_MS = 120;

export function useWindowResizeTransition() {
  useEffect(() => {
    const root = document.documentElement;
    let settleTimer: number | undefined;

    function handleResize() {
      root.dataset.windowResizing = "true";
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        delete root.dataset.windowResizing;
      }, RESIZE_SETTLE_DELAY_MS);
    }

    window.addEventListener("resize", handleResize, { passive: true });
    return () => {
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(settleTimer);
      delete root.dataset.windowResizing;
    };
  }, []);
}

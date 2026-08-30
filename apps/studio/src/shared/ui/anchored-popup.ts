import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface AnchoredPopupLayout {
  maxHeight: number;
  placement: "down" | "up";
}

interface VerticalBoundary {
  bottom: number;
  top: number;
}

interface PopupMetrics {
  gap: number;
  maxHeight: number;
  optionHeight: number;
}

const FALLBACK_METRICS: PopupMetrics = {
  gap: 6,
  maxHeight: 260,
  optionHeight: 38,
};

function cssPixelValue(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function popupMetrics(element: HTMLElement): PopupMetrics {
  const style = window.getComputedStyle(element);
  return {
    gap: cssPixelValue(style, "--popup-gap", FALLBACK_METRICS.gap),
    maxHeight: cssPixelValue(style, "--popup-max-height", FALLBACK_METRICS.maxHeight),
    optionHeight: cssPixelValue(
      style,
      "--popup-option-height",
      FALLBACK_METRICS.optionHeight,
    ),
  };
}

export function popupClippingBoundary(element: HTMLElement): VerticalBoundary {
  const boundary = { bottom: window.innerHeight, top: 0 };
  let ancestor = element.parentElement;

  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    if (/auto|clip|hidden|scroll/.test(`${style.overflow} ${style.overflowY}`)) {
      const rect = ancestor.getBoundingClientRect();
      boundary.top = Math.max(boundary.top, rect.top);
      boundary.bottom = Math.min(boundary.bottom, rect.bottom);
    }
    ancestor = ancestor.parentElement;
  }

  return boundary;
}

export function anchoredPopupLayout({
  boundary,
  gap,
  maxHeight,
  naturalHeight,
  triggerBottom,
  triggerTop,
}: {
  boundary: VerticalBoundary;
  gap: number;
  maxHeight: number;
  naturalHeight: number;
  triggerBottom: number;
  triggerTop: number;
}): AnchoredPopupLayout {
  const boundedNaturalHeight = Math.min(naturalHeight, maxHeight);
  const spaceAbove = Math.max(0, triggerTop - boundary.top - gap);
  const spaceBelow = Math.max(0, boundary.bottom - triggerBottom - gap);
  const placement = boundedNaturalHeight <= spaceBelow
    ? "down"
    : boundedNaturalHeight <= spaceAbove || spaceAbove > spaceBelow
      ? "up"
      : "down";

  return {
    maxHeight: Math.min(maxHeight, placement === "up" ? spaceAbove : spaceBelow),
    placement,
  };
}

export function useAnchoredPopup<
  Root extends HTMLElement,
  Trigger extends HTMLElement,
  Popup extends HTMLElement,
>({
  estimatedChromeHeight = 0,
  estimatedOptionCount,
  onDismiss,
  open,
  popupRef,
  rootRef,
  triggerRef,
}: {
  estimatedChromeHeight?: number;
  estimatedOptionCount: number;
  onDismiss: () => void;
  open: boolean;
  popupRef: RefObject<Popup | null>;
  rootRef: RefObject<Root | null>;
  triggerRef: RefObject<Trigger | null>;
}): AnchoredPopupLayout {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [layout, setLayout] = useState<AnchoredPopupLayout>({
    maxHeight: FALLBACK_METRICS.maxHeight,
    placement: "down",
  });

  useLayoutEffect(() => {
    if (!open) return;

    function positionPopup() {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!root || !trigger || !popup) return;

      const metrics = popupMetrics(root);
      const popupRect = popup.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const naturalHeight = popup.scrollHeight
        || popupRect.height
        || estimatedOptionCount * metrics.optionHeight + estimatedChromeHeight;
      const next = anchoredPopupLayout({
        boundary: popupClippingBoundary(root),
        gap: metrics.gap,
        maxHeight: metrics.maxHeight,
        naturalHeight,
        triggerBottom: triggerRect.bottom,
        triggerTop: triggerRect.top,
      });

      setLayout((current) => (
        current.placement === next.placement && current.maxHeight === next.maxHeight
          ? current
          : next
      ));
    }

    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(positionPopup);
    if (resizeObserver) {
      if (rootRef.current) resizeObserver.observe(rootRef.current);
      if (popupRef.current) resizeObserver.observe(popupRef.current);
    }
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
      resizeObserver?.disconnect();
    };
  }, [estimatedChromeHeight, estimatedOptionCount, open, popupRef, rootRef, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function dismissFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) dismissRef.current();
    }
    document.addEventListener("pointerdown", dismissFromOutside);
    return () => document.removeEventListener("pointerdown", dismissFromOutside);
  }, [open, rootRef]);

  return layout;
}

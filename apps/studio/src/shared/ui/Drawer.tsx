import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type Key,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import {
  resolveDrawerLayout,
  type DrawerMode,
  type DrawerSize,
} from "./drawer-config";
import "./drawer.css";

type DrawerSizeProp = DrawerSize | "default";

interface DrawerHostContextValue {
  host: HTMLElement | null;
  mode: DrawerMode;
  registerDrawer: (size: DrawerSize | null) => void;
  registerHost: (host: HTMLElement | null) => void;
}

const DrawerHostContext = createContext<DrawerHostContextValue | null>(null);

export interface DrawerProviderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

type DrawerFrameStyle = CSSProperties & { "--drawer-active-width"?: string };

export function DrawerProvider({
  children,
  className = "",
  style,
  ...props
}: DrawerProviderProps) {
  const [host, registerHost] = useState<HTMLElement | null>(null);
  const [activeSize, registerDrawer] = useState<DrawerSize | null>(null);
  const [frameWidth, setFrameWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  const [railWidth, setRailWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const frameElement: HTMLDivElement = frame;
    const rail = frameElement.querySelector<HTMLElement>(".workspace-sidebar");

    function updateGeometry() {
      const nextFrameWidth = frameElement.clientWidth || window.innerWidth;
      const nextRailWidth = rail?.getBoundingClientRect().width || rail?.clientWidth || 0;
      setFrameWidth(nextFrameWidth);
      setRailWidth(nextRailWidth);
    }

    updateGeometry();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateGeometry);
    observer?.observe(frameElement);
    if (rail) observer?.observe(rail);
    window.addEventListener("resize", updateGeometry);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateGeometry);
    };
  }, []);

  const layout = resolveDrawerLayout({
    frameWidth,
    railWidth,
    size: activeSize ?? "standard",
  });
  const frameStyle: DrawerFrameStyle = {
    ...style,
    "--drawer-active-width": `${layout.width}px`,
  };

  return (
    <DrawerHostContext.Provider
      value={{ host, mode: layout.mode, registerDrawer, registerHost }}
    >
      <div
        {...props}
        className={`drawer-frame ${className}`.trim()}
        data-drawer-mode={activeSize ? layout.mode : undefined}
        data-drawer-size={activeSize ?? undefined}
        ref={frameRef}
        style={frameStyle}
      >
        {children}
      </div>
    </DrawerHostContext.Provider>
  );
}

export function DrawerHost({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error("DrawerHost must be rendered inside DrawerProvider");

  const setHost = useCallback((node: HTMLDivElement | null) => {
    context.registerHost(node);
  }, [context.registerHost]);

  return (
    <div
      {...props}
      className={`drawer-host ${className}`.trim()}
      ref={setHost}
    />
  );
}

export interface DrawerProps {
  children: ReactNode;
  className?: string;
  contentKey?: Key;
  description?: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  size?: DrawerSizeProp;
  subheader?: ReactNode;
  title: ReactNode;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Drawer({
  children,
  className = "",
  contentKey,
  description,
  eyebrow,
  footer,
  onClose,
  open,
  returnFocusRef,
  size = "standard",
  subheader,
  title,
}: DrawerProps) {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error("Drawer must be rendered inside DrawerProvider");

  const { host, mode, registerDrawer } = context;
  const resolvedSize: DrawerSize = size === "default" ? "standard" : size;
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);
  const restoreFocusPendingRef = useRef(false);
  const [present, setPresent] = useState(open);

  useLayoutEffect(() => {
    if (!present) return;
    registerDrawer(resolvedSize);
    return () => registerDrawer(null);
  }, [present, registerDrawer, resolvedSize]);

  const restoreFocus = useCallback(() => {
    if (!restoreFocusPendingRef.current) return;
    restoreFocusPendingRef.current = false;
    if (returnTargetRef.current?.isConnected) returnTargetRef.current.focus();
  }, []);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    if (mode === "docked") {
      setPresent(false);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), 160);
    return () => window.clearTimeout(timeout);
  }, [mode, open, present]);

  useEffect(() => {
    if (!present || !host || mode !== "overlay") return;
    const siblings = Array.from(host.parentElement?.children ?? [])
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement && element !== host,
      )
      .map((element) => ({ element, inert: element.inert }));
    siblings.forEach(({ element }) => {
      element.inert = true;
    });
    return () => {
      siblings.forEach(({ element, inert }) => {
        element.inert = inert;
      });
    };
  }, [host, mode, present]);

  useEffect(() => {
    if (!open) return;
    const explicitTarget = returnFocusRef?.current;
    if (explicitTarget) returnTargetRef.current = explicitTarget;
    else if (!restoreFocusPendingRef.current) {
      returnTargetRef.current = document.activeElement as HTMLElement | null;
    }
    restoreFocusPendingRef.current = true;
  });

  useEffect(() => {
    if (!present) restoreFocus();
  }, [present, restoreFocus]);

  useEffect(() => () => restoreFocus(), [restoreFocus]);

  useEffect(() => {
    if (!open || !host) return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [host, open]);

  useEffect(() => {
    if (!open || !host || mode !== "docked") return;

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      onClose();
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [host, mode, onClose, open]);

  useLayoutEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [contentKey, open]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || mode !== "overlay") return;

    const focusable = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      surfaceRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!host || !present) return null;

  return createPortal(
    <div className="drawer-layer" data-mode={mode} data-state={open ? "open" : "closed"}>
      {mode === "overlay" && (
        <div
          aria-hidden="true"
          className="drawer-backdrop"
          onPointerDown={onClose}
        />
      )}
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal={mode === "overlay" ? true : undefined}
        className={`drawer-surface drawer-surface-${resolvedSize} ${className}`.trim()}
        data-size={resolvedSize}
        onKeyDown={handleKeyDown}
        ref={surfaceRef}
        role={mode === "overlay" ? "dialog" : "complementary"}
        tabIndex={-1}
      >
        <header className="drawer-header">
          <div className="drawer-heading">
            {eyebrow && <span className="drawer-eyebrow">{eyebrow}</span>}
            <h2
              className="drawer-title"
              id={titleId}
              title={typeof title === "string" ? title : undefined}
            >
              {title}
            </h2>
            {description && <div className="drawer-description" id={descriptionId}>{description}</div>}
          </div>
          <Button
            aria-label="Close drawer"
            className="drawer-close"
            icon="close"
            onClick={onClose}
            ref={closeButtonRef}
            size="sm"
            variant="ghost"
          />
        </header>
        <div className="drawer-subheader">{subheader}</div>
        <div className="drawer-body" ref={bodyRef}>{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>,
    host,
  );
}

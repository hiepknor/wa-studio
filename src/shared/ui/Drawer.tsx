import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import "./drawer.css";

export const DRAWER_DOCK_MIN_WIDTH = 1320;

type DrawerMode = "docked" | "overlay";

interface DrawerHostContextValue {
  host: HTMLElement | null;
  mode: DrawerMode;
  registerHost: (host: HTMLElement | null) => void;
}

const DrawerHostContext = createContext<DrawerHostContextValue | null>(null);

interface DrawerProviderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function DrawerProvider({ children, className = "", ...props }: DrawerProviderProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [host, registerHost] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<DrawerMode>(() =>
    typeof window !== "undefined" && window.innerWidth >= DRAWER_DOCK_MIN_WIDTH
      ? "docked"
      : "overlay",
  );

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    function updateMode(width: number) {
      const resolvedWidth = width || window.innerWidth;
      setMode(resolvedWidth >= DRAWER_DOCK_MIN_WIDTH ? "docked" : "overlay");
    }

    updateMode(frame.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => updateMode(frame.getBoundingClientRect().width);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver(([entry]) => updateMode(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <DrawerHostContext.Provider value={{ host, mode, registerHost }}>
      <div
        {...props}
        className={`drawer-frame ${className}`.trim()}
        data-drawer-mode={mode}
        ref={frameRef}
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

interface DrawerProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
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
  description,
  eyebrow,
  footer,
  onClose,
  open,
  returnFocusRef,
  title,
}: DrawerProps) {
  const context = useContext(DrawerHostContext);
  if (!context) throw new Error("Drawer must be rendered inside DrawerProvider");

  const { host, mode } = context;
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const [present, setPresent] = useState(open);

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
    if (!open || !host || mode !== "overlay") return;
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
  }, [host, mode, open]);

  useEffect(() => {
    if (!open) return;
    originRef.current = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    return () => {
      const returnTarget = returnFocusRef?.current ?? originRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!open || !host || mode !== "overlay") return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [host, mode, open]);

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
      <aside
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal={mode === "overlay" ? true : undefined}
        className={`drawer-surface ${className}`.trim()}
        onKeyDown={handleKeyDown}
        ref={surfaceRef}
        role={mode === "overlay" ? "dialog" : "complementary"}
        tabIndex={-1}
      >
        <header className="drawer-header">
          <div className="drawer-heading">
            {eyebrow && <span className="drawer-eyebrow">{eyebrow}</span>}
            <h2 className="drawer-title" id={titleId}>{title}</h2>
            {description && <span className="drawer-description" id={descriptionId}>{description}</span>}
          </div>
          <Button
            aria-label="Close drawer"
            className="drawer-close"
            icon="close"
            onClick={onClose}
            ref={closeButtonRef}
            size="sm"
            variant="ghost"
          >
            Close
          </Button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </aside>
    </div>,
    host,
  );
}

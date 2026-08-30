import { createPortal } from "react-dom";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";

import { Button } from "./Button";
import { acquireModalIsolation } from "./modal-isolation";
import "./modal-dialog.css";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalDialogProps {
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  closeDisabled?: boolean;
  contentKey?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  open: boolean;
  size?: "default" | "workflow";
  title: ReactNode;
}

export function ModalDialog({
  bodyClassName = "",
  children,
  className = "",
  closeDisabled = false,
  contentKey,
  description,
  eyebrow,
  footer,
  headerActions,
  initialFocusRef,
  onClose,
  open,
  size = "default",
  title,
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const layer = layerRef.current;
    if (!layer) return;
    const releaseIsolation = acquireModalIsolation(layer, returnFocusRef.current);
    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      const focusIsUntouched = activeElement === returnFocusRef.current
        || activeElement === document.body
        || activeElement === document.documentElement
        || activeElement === surfaceRef.current;
      if (!focusIsUntouched) return;
      (initialFocusRef?.current ?? closeRef.current)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      releaseIsolation();
    };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open || contentKey === undefined || !bodyRef.current) return;
    bodyRef.current.scrollTop = 0;
  }, [contentKey, open]);

  function requestClose() {
    if (!closeDisabled) onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (!focusable.length) {
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

  if (!open) return null;

  return createPortal(
    <div
      className={`modal-dialog-layer modal-dialog-layer-${size}`}
      ref={layerRef}
    >
      <div
        aria-hidden="true"
        className="modal-dialog-backdrop"
        onPointerDown={requestClose}
      />
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`modal-dialog ${className}`.trim()}
        data-size={size}
        onKeyDown={handleKeyDown}
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="modal-dialog-header">
          <div className="modal-dialog-heading">
            {eyebrow && <span className="modal-dialog-eyebrow">{eyebrow}</span>}
            <h2 className="modal-dialog-title" id={titleId}>{title}</h2>
            {description && <p className="modal-dialog-description" id={descriptionId}>{description}</p>}
          </div>
          <div className="modal-dialog-header-actions">
            {headerActions}
            <Button
              aria-label="Close dialog"
              className="modal-dialog-close"
              disabled={closeDisabled}
              icon="close"
              onClick={requestClose}
              ref={closeRef}
              size="sm"
              variant="ghost"
            />
          </div>
        </header>
        <div
          className={`modal-dialog-body ${bodyClassName}`.trim()}
          ref={bodyRef}
        >
          {children}
        </div>
        {footer && <footer className="modal-dialog-footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

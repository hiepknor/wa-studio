import { createPortal } from "react-dom";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";

import { Button } from "./Button";
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
  children: ReactNode;
  closeDisabled?: boolean;
  description?: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: ReactNode;
}

export function ModalDialog({
  children,
  closeDisabled = false,
  description,
  eyebrow,
  footer,
  onClose,
  open,
  title,
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const layer = layerRef.current;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer)
      .map((element) => ({ element, inert: element.inert }));
    const previousOverflow = document.body.style.overflow;
    siblings.forEach(({ element }) => { element.inert = true; });
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      siblings.forEach(({ element, inert }) => { element.inert = inert; });
      document.body.style.overflow = previousOverflow;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open]);

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
    <div className="modal-dialog-layer" ref={layerRef}>
      <button
        aria-label="Close modal"
        className="modal-dialog-backdrop"
        onClick={requestClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal-dialog"
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
        </header>
        <div className="modal-dialog-body">{children}</div>
        {footer && <footer className="modal-dialog-footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

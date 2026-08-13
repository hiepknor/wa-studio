import { createPortal } from "react-dom";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";

import { Button } from "./Button";
import "./confirmation-dialog.css";

interface ConfirmationDialogProps {
  body: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

export function ConfirmationDialog({
  body,
  cancelLabel = "Cancel",
  confirmLabel,
  confirmVariant = "primary",
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement;
    cancelRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="confirmation-dialog-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Tab") {
          const next = event.shiftKey ? confirmRef.current : cancelRef.current;
          const boundary = event.shiftKey ? cancelRef.current : confirmRef.current;
          if (document.activeElement === boundary) {
            event.preventDefault();
            next?.focus();
          }
        }
      }}
    >
      <button
        aria-label="Close confirmation"
        className="confirmation-dialog-backdrop"
        onClick={onCancel}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-describedby="confirmation-dialog-body"
        aria-labelledby="confirmation-dialog-title"
        aria-modal="true"
        className="confirmation-dialog"
        role="dialog"
      >
        <div className="confirmation-dialog-content">
          <h2 id="confirmation-dialog-title">{title}</h2>
          <p id="confirmation-dialog-body">{body}</p>
        </div>
        <footer className="confirmation-dialog-footer">
          <Button onClick={onCancel} ref={cancelRef}>{cancelLabel}</Button>
          <Button onClick={onConfirm} ref={confirmRef} variant={confirmVariant}>{confirmLabel}</Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

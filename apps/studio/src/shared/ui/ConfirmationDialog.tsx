import { createPortal } from "react-dom";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";

import { Button } from "./Button";
import "./confirmation-dialog.css";

interface ConfirmationDialogProps {
  body: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

export function ConfirmationDialog({
  body,
  busy = false,
  busyLabel,
  cancelLabel = "Cancel",
  confirmLabel,
  confirmDisabled = false,
  confirmVariant = "primary",
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement;
    cancelRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (busy) dialogRef.current?.focus();
    else if (document.activeElement === dialogRef.current) cancelRef.current?.focus();
  }, [busy, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="confirmation-dialog-layer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Tab") {
          if (busy) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const focusable = [cancelRef.current, confirmRef.current]
            .filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (
            focusable.length === 0
            || (event.shiftKey && document.activeElement === first)
            || (!event.shiftKey && document.activeElement === last)
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }
      }}
    >
      <button
        aria-label="Close confirmation"
        className="confirmation-dialog-backdrop"
        onClick={() => { if (!busy) onCancel(); }}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-busy={busy || undefined}
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirmation-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="confirmation-dialog-content">
          <h2 id={titleId}>{title}</h2>
          <div className="confirmation-dialog-body" id={bodyId}>{body}</div>
        </div>
        <footer className="confirmation-dialog-footer">
          <Button disabled={busy} onClick={onCancel} ref={cancelRef}>{cancelLabel}</Button>
          <Button disabled={confirmDisabled} loading={busy} onClick={onConfirm} ref={confirmRef} variant={confirmVariant}>
            {busy ? busyLabel ?? confirmLabel : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

import { createPortal } from "react-dom";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";

import { Button } from "./Button";
import { InlineAlert } from "./InlineAlert";
import { acquireModalIsolation } from "./modal-isolation";
import "./confirmation-dialog.css";

interface ConfirmationDialogProps {
  body: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  error?: ReactNode;
  errorTitle?: ReactNode;
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
  error,
  errorTitle = "Action failed",
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirmRequestedRef = useRef(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const layer = layerRef.current;
    if (!layer) return;
    const releaseIsolation = acquireModalIsolation(layer, returnFocusRef.current);
    cancelRef.current?.focus();
    return releaseIsolation;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (busy) dialogRef.current?.focus();
    else if (document.activeElement === dialogRef.current) cancelRef.current?.focus();
  }, [busy, open]);

  function requestConfirm() {
    if (busy || confirmDisabled || confirmRequestedRef.current) return;
    confirmRequestedRef.current = true;
    try {
      onConfirm();
    } finally {
      queueMicrotask(() => { confirmRequestedRef.current = false; });
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="confirmation-dialog-layer"
      ref={layerRef}
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
      <div
        aria-hidden="true"
        className="confirmation-dialog-backdrop"
        onPointerDown={() => { if (!busy) onCancel(); }}
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
          <div className="confirmation-dialog-body" id={bodyId}>
            {body}
            {error && <InlineAlert className="confirmation-dialog-error" title={errorTitle}>{error}</InlineAlert>}
          </div>
        </div>
        <footer className="confirmation-dialog-footer">
          <Button disabled={busy} onClick={onCancel} ref={cancelRef}>{cancelLabel}</Button>
          <Button disabled={confirmDisabled} loading={busy} onClick={requestConfirm} ref={confirmRef} variant={confirmVariant}>
            {busy ? busyLabel ?? confirmLabel : confirmLabel}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

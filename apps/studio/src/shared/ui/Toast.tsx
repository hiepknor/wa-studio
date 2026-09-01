import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import { Button } from "./Button";
import { feedbackRole, type FeedbackTone } from "./feedback-tone";
import { ToastContext, type ToastInput } from "./ToastContext";
import "./toast.css";

export { useToast } from "./ToastContext";
export type { ToastInput } from "./ToastContext";

export type ToastProviderProps = PropsWithChildren;

const MAX_VISIBLE_TOASTS = 3;
const EXIT_DURATION = 120;

const TONE_ICON: Record<FeedbackTone, AppIconName> = {
  danger: "circle-alert",
  info: "info",
  neutral: "info",
  success: "check",
  warning: "triangle-alert",
};

function defaultDuration(tone: FeedbackTone): number {
  if (tone === "danger") return 0;
  if (tone === "warning") return 6_000;
  return 4_000;
}

interface ToastRecord extends ToastInput {
  id: string;
  revision: number;
}

interface ToastItemProps {
  dismiss: (id: string) => void;
  toast: ToastRecord;
}

function ToastItem({ dismiss, toast }: ToastItemProps) {
  const [paused, setPaused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const duration = toast.duration ?? defaultDuration(toast.tone ?? "neutral");
  const tone = toast.tone ?? "neutral";
  const exitTimeoutRef = useRef<number | null>(null);
  const clockRef = useRef({
    remaining: duration,
    revision: toast.revision,
    startedAt: null as number | null,
  });

  if (clockRef.current.revision !== toast.revision) {
    clockRef.current = { remaining: duration, revision: toast.revision, startedAt: null };
  }

  const beginDismiss = useCallback(() => {
    if (exitTimeoutRef.current !== null) return;
    setExiting(true);
    exitTimeoutRef.current = window.setTimeout(() => dismiss(toast.id), EXIT_DURATION);
  }, [dismiss, toast.id]);

  useEffect(() => {
    setExiting(false);
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }
  }, [toast.revision]);

  useEffect(() => {
    if (paused || duration <= 0) return;
    const clock = clockRef.current;
    const startedAt = Date.now();
    clock.startedAt = startedAt;
    const timeout = window.setTimeout(() => {
      clock.remaining = 0;
      clock.startedAt = null;
      beginDismiss();
    }, clock.remaining);
    return () => {
      window.clearTimeout(timeout);
      if (clock.startedAt === startedAt) {
        clock.remaining = Math.max(0, clock.remaining - (Date.now() - startedAt));
        clock.startedAt = null;
      }
    };
  }, [beginDismiss, duration, paused, toast.revision]);

  useEffect(() => () => {
    if (exitTimeoutRef.current !== null) window.clearTimeout(exitTimeoutRef.current);
  }, []);

  return (
    <div
      aria-atomic="true"
      className={`toast toast-${tone}`}
      data-state={exiting ? "exiting" : "open"}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onKeyDown={(event) => {
        if (event.key === "Escape") beginDismiss();
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role={feedbackRole(tone)}
    >
      <span className="toast-indicator">
        <AppIcon name={TONE_ICON[tone]} size="sm" />
      </span>
      <div className="toast-copy">
        <strong className="toast-title">{toast.title}</strong>
        {toast.description !== undefined && toast.description !== null && (
          <div className="toast-description">{toast.description}</div>
        )}
      </div>
      <div className="toast-actions">
        {toast.action}
        <Button
          aria-label="Dismiss notification"
          className="toast-dismiss"
          icon="close"
          onClick={beginDismiss}
          size="sm"
          variant="ghost"
        />
      </div>
    </div>
  );
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  const nextRevision = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = input.id ?? `toast-${++nextId.current}`;
    setToasts((current) => {
      const record = { ...input, id, revision: ++nextRevision.current };
      const index = current.findIndex((toast) => toast.id === id);
      if (index < 0) return [...current, record];
      const next = [...current];
      next[index] = record;
      return next;
    });
    return id;
  }, []);

  const value = useMemo(() => ({ dismiss, notify }), [dismiss, notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-label="Notifications" className="toast-viewport" role="region">
        {toasts.slice(0, MAX_VISIBLE_TOASTS).map((toast) => (
          <ToastItem dismiss={dismiss} key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

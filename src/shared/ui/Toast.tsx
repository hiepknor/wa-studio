import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppIcon } from "./AppIcon";
import type { FeedbackTone } from "./feedback-tone";
import { InlineAlert } from "./InlineAlert";
import "./toast.css";

const MAX_VISIBLE_TOASTS = 3;

function defaultDuration(tone: FeedbackTone): number {
  if (tone === "danger") return 0;
  if (tone === "warning") return 6_000;
  return 4_000;
}

export interface ToastInput {
  action?: ReactNode;
  description?: ReactNode;
  duration?: number;
  id?: string;
  title: ReactNode;
  tone?: FeedbackTone;
}

interface ToastRecord extends ToastInput {
  id: string;
}

interface ToastContextValue {
  dismiss: (id: string) => void;
  notify: (toast: ToastInput) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastItemProps {
  dismiss: (id: string) => void;
  toast: ToastRecord;
}

function ToastItem({ dismiss, toast }: ToastItemProps) {
  const [paused, setPaused] = useState(false);
  const duration = toast.duration ?? defaultDuration(toast.tone ?? "neutral");

  useEffect(() => {
    if (paused || duration <= 0) return;
    const timeout = window.setTimeout(() => dismiss(toast.id), duration);
    return () => window.clearTimeout(timeout);
  }, [dismiss, duration, paused, toast.id]);

  return (
    <InlineAlert
      action={(
        <div className="toast-actions">
          {toast.action}
          <button
            aria-label="Dismiss notification"
            className="toast-dismiss"
            onClick={() => dismiss(toast.id)}
            type="button"
          >
            <AppIcon name="close" size="sm" />
          </button>
        </div>
      )}
      className="toast"
      indicator
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      title={toast.title}
      tone={toast.tone ?? "neutral"}
    >
      {toast.description}
    </InlineAlert>
  );
}

export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = input.id ?? `toast-${++nextId.current}`;
    setToasts((current) => {
      const next = [...current.filter((toast) => toast.id !== id), { ...input, id }];
      return next.slice(-MAX_VISIBLE_TOASTS);
    });
    return id;
  }, []);

  const value = useMemo(() => ({ dismiss, notify }), [dismiss, notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-label="Notifications" className="toast-viewport" role="region">
        {toasts.map((toast) => (
          <ToastItem dismiss={dismiss} key={toast.id} toast={toast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}

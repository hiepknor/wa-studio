import { createContext, type ReactNode, useContext } from "react";

import type { FeedbackTone } from "./feedback-tone";

export interface ToastInput {
  action?: ReactNode;
  description?: ReactNode;
  duration?: number;
  id?: string;
  title: ReactNode;
  tone?: FeedbackTone;
}

export interface ToastContextValue {
  dismiss: (id: string) => void;
  notify: (toast: ToastInput) => string;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}

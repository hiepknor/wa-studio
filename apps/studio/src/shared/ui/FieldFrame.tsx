import type { ReactNode } from "react";

import {
  DEFAULT_FIELD_SIZE,
  type FieldSize,
  fieldSizeClassName,
} from "./field-size";

interface FieldFrameProps {
  children: ReactNode;
  containerClassName?: string;
  description?: ReactNode;
  descriptionId?: string;
  error?: ReactNode;
  errorId?: string;
  inputId: string;
  invalid?: boolean;
  label: ReactNode;
  labelHidden?: boolean;
  size?: FieldSize;
}

export function FieldFrame({
  children,
  containerClassName = "",
  description,
  descriptionId,
  error,
  errorId,
  inputId,
  invalid = false,
  label,
  labelHidden = false,
  size = DEFAULT_FIELD_SIZE,
}: FieldFrameProps) {
  const message = error ?? description;
  const messageId = error ? errorId : descriptionId;

  return (
    <div
      className={`text-field ${fieldSizeClassName(size)} ${containerClassName}`.trim()}
      data-invalid={invalid || undefined}
    >
      <label className={labelHidden ? "text-field-label-hidden" : "text-field-label"} htmlFor={inputId}>
        {label}
      </label>
      <div className="text-field-control">{children}</div>
      {message && (
        <span
          className={error ? "text-field-message text-field-error" : "text-field-message text-field-description"}
          id={messageId}
          role={error ? "alert" : undefined}
        >
          {message}
        </span>
      )}
    </div>
  );
}

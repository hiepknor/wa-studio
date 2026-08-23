import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";

import { FieldFrame } from "./FieldFrame";
import { DEFAULT_FIELD_SIZE, type FieldSize } from "./field-size";
import "./text-field.css";

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  containerClassName?: string;
  description?: ReactNode;
  error?: ReactNode;
  label: ReactNode;
  labelHidden?: boolean;
  monospace?: boolean;
  size?: FieldSize;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({
    "aria-describedby": ariaDescribedBy,
    className = "",
    containerClassName = "",
    description,
    error,
    id,
    label,
    labelHidden = false,
    monospace = false,
    size = DEFAULT_FIELD_SIZE,
    ...props
  }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const descriptionId = description && !error ? `${inputId}-description` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;
    const describedBy = [ariaDescribedBy, errorId ?? descriptionId].filter(Boolean).join(" ") || undefined;
    const invalid = Boolean(error) || props["aria-invalid"] === true || props["aria-invalid"] === "true";
    return (
      <FieldFrame
        containerClassName={containerClassName}
        description={description}
        descriptionId={descriptionId}
        error={error}
        errorId={errorId}
        inputId={inputId}
        invalid={invalid}
        label={label}
        labelHidden={labelHidden}
        size={size}
      >
        <textarea
          {...props}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={`${monospace ? "text-field-input-mono" : ""} ${className}`.trim()}
          id={inputId}
          ref={ref}
        />
      </FieldFrame>
    );
  },
);

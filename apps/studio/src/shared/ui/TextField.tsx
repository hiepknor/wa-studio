import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import { FieldFrame } from "./FieldFrame";
import { DEFAULT_FIELD_SIZE, type FieldSize } from "./field-size";
import "./text-field.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  containerClassName?: string;
  description?: ReactNode;
  error?: ReactNode;
  icon?: AppIconName;
  label: ReactNode;
  labelHidden?: boolean;
  monospace?: boolean;
  size?: FieldSize;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    "aria-describedby": ariaDescribedBy,
    className = "",
    containerClassName = "",
    description,
    error,
    icon,
    id,
    label,
    labelHidden = false,
    monospace = false,
    size = DEFAULT_FIELD_SIZE,
    ...props
  },
  ref,
) {
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
      {icon && <AppIcon className="text-field-icon" name={icon} size="sm" />}
      <input
        {...props}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className={`${icon ? "text-field-input-with-icon" : ""} ${monospace ? "text-field-input-mono" : ""} ${className}`.trim()}
        id={inputId}
        ref={ref}
      />
    </FieldFrame>
  );
});

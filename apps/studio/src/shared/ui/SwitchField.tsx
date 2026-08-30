import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import "./switch-field.css";

export interface SwitchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  description?: ReactNode;
  label: ReactNode;
}

export const SwitchField = forwardRef<HTMLInputElement, SwitchFieldProps>(function SwitchField(
  {
    "aria-describedby": ariaDescribedBy,
    "aria-labelledby": ariaLabelledBy,
    className = "",
    description,
    disabled,
    id,
    label,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const labelId = `${inputId}-label`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

  return (
    <label className={`switch-field ${disabled ? "is-disabled" : ""} ${className}`.trim()} htmlFor={inputId}>
      <input
        {...props}
        aria-describedby={describedBy}
        aria-labelledby={ariaLabelledBy ?? labelId}
        className="focus-delegate-input"
        disabled={disabled}
        id={inputId}
        ref={ref}
        role="switch"
        type="checkbox"
      />
      <span aria-hidden="true" className="switch-field-control focus-delegate-surface"><span /></span>
      <span className="switch-field-copy">
        <strong id={labelId}>{label}</strong>
        {description && <small id={descriptionId}>{description}</small>}
      </span>
    </label>
  );
});

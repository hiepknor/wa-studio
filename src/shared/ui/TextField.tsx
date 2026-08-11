import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import "./text-field.css";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  containerClassName?: string;
  description?: ReactNode;
  icon?: AppIconName;
  label: ReactNode;
  labelHidden?: boolean;
  monospace?: boolean;
  size?: "sm" | "md";
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    "aria-describedby": ariaDescribedBy,
    className = "",
    containerClassName = "",
    description,
    icon,
    id,
    label,
    labelHidden = false,
    monospace = false,
    size = "md",
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`text-field text-field-${size} ${containerClassName}`.trim()}>
      <label className={labelHidden ? "text-field-label-hidden" : "text-field-label"} htmlFor={inputId}>
        {label}
      </label>
      <div className="text-field-control">
        {icon && <AppIcon className="text-field-icon" name={icon} size="sm" />}
        <input
          {...props}
          aria-describedby={describedBy}
          className={`${icon ? "text-field-input-with-icon" : ""} ${monospace ? "text-field-input-mono" : ""} ${className}`.trim()}
          id={inputId}
          ref={ref}
        />
      </div>
      {description && <span className="text-field-description" id={descriptionId}>{description}</span>}
    </div>
  );
});

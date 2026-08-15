import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from "react";

import {
  DEFAULT_FIELD_SIZE,
  type FieldSize,
  fieldSizeClassName,
} from "./field-size";
import "./text-field.css";

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  containerClassName?: string;
  description?: ReactNode;
  label: ReactNode;
  size?: FieldSize;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField({
    "aria-describedby": ariaDescribedBy,
    children,
    className = "",
    containerClassName = "",
    description,
    id,
    label,
    size = DEFAULT_FIELD_SIZE,
    ...props
  }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const descriptionId = description ? `${inputId}-description` : undefined;
    const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
    return (
      <div className={`text-field ${fieldSizeClassName(size)} ${containerClassName}`.trim()}>
        <label className="text-field-label" htmlFor={inputId}>{label}</label>
        <div className="text-field-control">
          <select {...props} aria-describedby={describedBy} className={className} id={inputId} ref={ref}>{children}</select>
        </div>
        {description && <span className="text-field-description" id={descriptionId}>{description}</span>}
      </div>
    );
  },
);

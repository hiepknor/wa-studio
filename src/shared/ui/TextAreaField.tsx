import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";

import "./text-field.css";

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  containerClassName?: string;
  description?: ReactNode;
  label: ReactNode;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField({
    "aria-describedby": ariaDescribedBy,
    className = "",
    containerClassName = "",
    description,
    id,
    label,
    ...props
  }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const descriptionId = description ? `${inputId}-description` : undefined;
    const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
    return (
      <div className={`text-field ${containerClassName}`.trim()}>
        <label className="text-field-label" htmlFor={inputId}>{label}</label>
        <div className="text-field-control">
          <textarea {...props} aria-describedby={describedBy} className={className} id={inputId} ref={ref} />
        </div>
        {description && <span className="text-field-description" id={descriptionId}>{description}</span>}
      </div>
    );
  },
);

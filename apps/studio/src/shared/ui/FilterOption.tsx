import { type InputHTMLAttributes, type ReactNode } from "react";

import "./filter-option.css";

export interface FilterOptionProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  children: ReactNode;
  type?: "checkbox" | "radio";
}

export function FilterOption({
  children,
  className = "",
  disabled,
  type = "checkbox",
  ...props
}: FilterOptionProps) {
  return (
    <label className={`filter-option ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input
        {...props}
        className="filter-option-input"
        disabled={disabled}
        type={type}
      />
      <span className="filter-option-label">{children}</span>
    </label>
  );
}

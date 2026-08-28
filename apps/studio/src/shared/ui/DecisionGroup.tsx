import { type ReactNode, useId } from "react";

import "./decision-group.css";
import "./text-field.css";

export interface DecisionGroupOption<T extends string> {
  description: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  meta?: ReactNode;
  value: T;
}

interface DecisionGroupProps<T extends string> {
  "aria-describedby"?: string;
  containerClassName?: string;
  disabled?: boolean;
  id?: string;
  label: ReactNode;
  labelHidden?: boolean;
  name?: string;
  onChange: (value: T) => void;
  options: readonly DecisionGroupOption<T>[];
  value: T;
}

export function DecisionGroup<T extends string>({
  "aria-describedby": ariaDescribedBy,
  containerClassName = "",
  disabled = false,
  id,
  label,
  labelHidden = false,
  name,
  onChange,
  options,
  value,
}: DecisionGroupProps<T>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;

  return (
    <div className={`decision-group text-field ${containerClassName}`.trim()}>
      <span className={`text-field-label ${labelHidden ? "text-field-label-hidden" : ""}`.trim()} id={labelId}>{label}</span>
      <div
        aria-describedby={ariaDescribedBy}
        aria-labelledby={labelId}
        className="decision-group-control"
        data-disabled={disabled || undefined}
        role="radiogroup"
      >
        {options.map((option) => (
          <label className="decision-group-option" key={option.value}>
            <input
              aria-label={typeof option.label === "string" ? option.label : undefined}
              checked={option.value === value}
              className="decision-group-input"
              disabled={disabled || option.disabled}
              name={name ?? generatedId}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span aria-hidden="true" className="decision-group-indicator" />
            <span className="decision-group-copy">
              <span className="decision-group-title"><strong>{option.label}</strong>{option.meta}</span>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

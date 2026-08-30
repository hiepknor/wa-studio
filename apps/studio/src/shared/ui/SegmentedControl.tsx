import { type ReactNode, useId } from "react";

import {
  DEFAULT_FIELD_SIZE,
  type FieldSize,
  fieldSizeClassName,
} from "./field-size";
import "./segmented-control.css";
import "./text-field.css";

export interface SegmentedControlOption<T extends string> {
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  value: T;
}

export interface SegmentedControlProps<T extends string> {
  "aria-describedby"?: string;
  containerClassName?: string;
  disabled?: boolean;
  id?: string;
  label: ReactNode;
  labelHidden?: boolean;
  name?: string;
  onChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  size?: FieldSize;
  value: T;
}

export function SegmentedControl<T extends string>({
  "aria-describedby": ariaDescribedBy,
  containerClassName = "",
  disabled = false,
  id,
  label,
  labelHidden = false,
  name,
  onChange,
  options,
  size = DEFAULT_FIELD_SIZE,
  value,
}: SegmentedControlProps<T>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const selectedOption = options.find((option) => option.value === value);
  const descriptionId = selectedOption?.description ? `${controlId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`segmented-control text-field ${fieldSizeClassName(size)} ${containerClassName}`.trim()}>
      <span className={`text-field-label ${labelHidden ? "text-field-label-hidden" : ""}`.trim()} id={labelId}>{label}</span>
      <div
        aria-describedby={describedBy}
        aria-labelledby={labelId}
        className="segmented-control-control focus-delegate-surface"
        data-disabled={disabled || undefined}
        role="radiogroup"
      >
        {options.map((option) => (
          <label className="segmented-control-option" key={option.value}>
            <input
              checked={option.value === value}
              className="segmented-control-input focus-delegate-input"
              disabled={disabled || option.disabled}
              name={name ?? generatedId}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {selectedOption?.description && (
        <span className="text-field-description" id={descriptionId}>{selectedOption.description}</span>
      )}
    </div>
  );
}

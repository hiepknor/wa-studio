import type { ButtonHTMLAttributes } from "react";

import { AppIcon } from "./AppIcon";
import "./filter-chip.css";

interface FilterChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "type"> {
  label: string;
  onRemove: () => void;
  removeLabel?: string;
}

export function FilterChip({
  className = "",
  label,
  onRemove,
  removeLabel = `Remove ${label} filter`,
  ...props
}: FilterChipProps) {
  return (
    <button
      {...props}
      aria-label={removeLabel}
      className={`data-filter-chip ${className}`.trim()}
      onClick={onRemove}
      type="button"
    >
      <span>{label}</span>
      <AppIcon name="close" size="xs" />
    </button>
  );
}

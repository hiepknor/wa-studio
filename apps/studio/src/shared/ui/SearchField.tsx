import type { KeyboardEventHandler, Ref } from "react";

import { TextField } from "./TextField";
import "./search-field.css";

interface SearchFieldProps {
  id?: string;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  loading?: boolean;
  onChange: (value: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  placeholder?: string;
  value: string;
  variant?: "contained" | "toolbar";
}

export function SearchField({
  id,
  inputRef,
  label,
  loading = false,
  onChange,
  onKeyDown,
  placeholder,
  value,
  variant = "contained",
}: SearchFieldProps) {
  return (
    <TextField
      aria-busy={loading || undefined}
      containerClassName={`search-field search-field-${variant}`}
      controlClassName={variant === "contained" ? "focus-owner" : undefined}
      icon="search"
      id={id}
      label={label}
      labelHidden
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      size="sm"
      ref={inputRef}
      type="search"
      value={value}
    />
  );
}

import { TextField } from "./TextField";
import "./search-field.css";

interface SearchFieldProps {
  id?: string;
  label: string;
  loading?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  variant?: "contained" | "toolbar";
}

export function SearchField({
  id,
  label,
  loading = false,
  onChange,
  placeholder,
  value,
  variant = "contained",
}: SearchFieldProps) {
  return (
    <TextField
      aria-busy={loading || undefined}
      containerClassName={`search-field search-field-${variant}`}
      icon="search"
      id={id}
      label={label}
      labelHidden
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      size="sm"
      type="search"
      value={value}
    />
  );
}

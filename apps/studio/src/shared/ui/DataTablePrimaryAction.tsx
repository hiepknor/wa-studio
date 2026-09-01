import type { ButtonHTMLAttributes } from "react";

import "./data-table-primary-action.css";

export interface DataTablePrimaryActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

export function DataTablePrimaryAction({
  className = "",
  type = "button",
  ...props
}: DataTablePrimaryActionProps) {
  return (
    <button
      {...props}
      className={`data-primary-action ${className}`.trim()}
      type={type}
    />
  );
}

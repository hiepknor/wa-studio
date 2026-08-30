import type { ButtonHTMLAttributes } from "react";

import "./data-table-primary-action.css";

export function DataTablePrimaryAction({
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`data-primary-action ${className}`.trim()}
      type={type}
    />
  );
}

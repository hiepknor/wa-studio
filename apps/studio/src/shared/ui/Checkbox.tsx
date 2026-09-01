import { forwardRef, type InputHTMLAttributes } from "react";

import "./checkbox.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className = "", ...props },
  ref,
) {
  return (
    <input
      {...props}
      className={`checkbox ${className}`.trim()}
      ref={ref}
      type="checkbox"
    />
  );
});

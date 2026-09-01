import { forwardRef, type ButtonHTMLAttributes } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import "./button.css";

export type ButtonSize = "sm" | "md" | "lg";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: AppIconName;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className = "",
    disabled,
    icon,
    loading = false,
    size = "md",
    type = "button",
    variant = "secondary",
    ...props
  },
  ref,
  ) {
  const leadingIcon = loading ? "refresh" : icon;
  const hasLabel = children !== undefined && children !== null && children !== false;
  const iconOnly = Boolean(leadingIcon) && !hasLabel;

  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={`button button-${size} button-${variant} ${iconOnly ? "button-icon-only" : ""} ${className}`.trim()}
      disabled={disabled || loading}
      ref={ref}
      type={type}
    >
      {leadingIcon && (
        <AppIcon
          className={loading ? "button-icon ui-icon-spin" : "button-icon"}
          name={leadingIcon}
          size={size}
        />
      )}
      {hasLabel && <span className="button-label">{children}</span>}
    </button>
  );
});

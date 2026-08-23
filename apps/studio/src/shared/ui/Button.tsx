import { forwardRef, type ButtonHTMLAttributes } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import "./button.css";

type ButtonSize = "sm" | "md" | "lg";
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: AppIconName;
  loading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

const ICON_SIZE: Record<ButtonSize, "xs" | "sm" | "md"> = {
  sm: "xs",
  md: "sm",
  lg: "md",
};

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

  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={`button button-${size} button-${variant} ${className}`.trim()}
      disabled={disabled || loading}
      ref={ref}
      type={type}
    >
      {leadingIcon && (
        <AppIcon
          className={loading ? "button-icon ui-icon-spin" : "button-icon"}
          name={leadingIcon}
          size={ICON_SIZE[size]}
        />
      )}
      {hasLabel && <span className="button-label">{children}</span>}
    </button>
  );
});

import { AppIcon } from "./AppIcon";
import type { DropdownTriggerProps } from "./DropdownMenu";
import "./update-action-trigger.css";

interface UpdateActionTriggerProps {
  ariaLabel: string;
  busy?: boolean;
  label: string;
  triggerProps: DropdownTriggerProps;
}

export function UpdateActionTrigger({
  ariaLabel,
  busy = false,
  label,
  triggerProps,
}: UpdateActionTriggerProps) {
  return (
    <button
      {...triggerProps}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      className="button button-md button-secondary update-action-trigger"
      type="button"
    >
      <AppIcon
        className={`button-icon ${busy ? "ui-icon-spin" : ""}`.trim()}
        name="refresh"
        size="sm"
      />
      <span className="button-label update-action-label">{label}</span>
      <span aria-hidden="true" className="update-action-divider" />
      <AppIcon className="update-action-chevron" name="chevron-down" size="xs" />
    </button>
  );
}

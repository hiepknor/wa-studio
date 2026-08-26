import { AppIcon } from "./AppIcon";
import { Button } from "./Button";
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
    <Button
      {...triggerProps}
      aria-label={ariaLabel}
      className="update-action-trigger"
      icon="refresh"
      loading={busy}
    >
      <span className="update-action-label">{label}</span>
      <span aria-hidden="true" className="update-action-divider" />
      <AppIcon className="update-action-chevron" name="chevron-down" size="xs" />
    </Button>
  );
}

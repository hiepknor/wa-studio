import type { DropdownTriggerProps } from "./DropdownMenu";
import { Button } from "./Button";
import "./overflow-menu-trigger.css";

interface OverflowMenuTriggerProps {
  ariaLabel: string;
  triggerProps: DropdownTriggerProps;
}

export function OverflowMenuTrigger({
  ariaLabel,
  triggerProps,
}: OverflowMenuTriggerProps) {
  return (
    <Button
      {...triggerProps}
      aria-label={ariaLabel}
      className="overflow-menu-trigger"
      icon="more"
      size="sm"
      variant="ghost"
    />
  );
}

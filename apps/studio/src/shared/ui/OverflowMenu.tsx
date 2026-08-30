import type { ReactNode } from "react";

import { DropdownMenu } from "./DropdownMenu";
import { OverflowMenuTrigger } from "./OverflowMenuTrigger";

export interface OverflowMenuProps {
  ariaLabel: string;
  children: ReactNode;
  triggerLabel: string;
}

export function OverflowMenu({
  ariaLabel,
  children,
  triggerLabel,
}: OverflowMenuProps) {
  return (
    <DropdownMenu
      ariaLabel={ariaLabel}
      contentClassName="action-menu"
      portal
      trigger={(triggerProps) => (
        <OverflowMenuTrigger ariaLabel={triggerLabel} triggerProps={triggerProps} />
      )}
    >
      {children}
    </DropdownMenu>
  );
}

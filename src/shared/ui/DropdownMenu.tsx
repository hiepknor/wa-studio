import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { AppIcon, type AppIconName } from "./AppIcon";

export interface DropdownTriggerProps {
  "aria-controls": string;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref: RefObject<HTMLButtonElement | null>;
}

interface DropdownMenuProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  trigger: (props: DropdownTriggerProps) => ReactNode;
}

function enabledItems(container: HTMLDivElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
  ));
}

export function DropdownMenu({
  ariaLabel,
  children,
  className = "",
  contentClassName = "",
  disabled = false,
  trigger,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    enabledItems(contentRef.current)[0]?.focus();

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!disabled) setOpen(true);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = enabledItems(contentRef.current);
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "Tab") {
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  }

  function handleMenuClick(event: ReactPointerEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
    if (item && item.getAttribute("aria-disabled") !== "true" && !item.hasAttribute("disabled")) {
      close({ restoreFocus: true });
    }
  }

  return (
    <div className={`menu ${className}`.trim()} ref={rootRef}>
      {trigger({
        "aria-controls": contentId,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        onClick: () => !disabled && setOpen((current) => !current),
        onKeyDown: handleTriggerKeyDown,
        ref: triggerRef,
      })}
      {open && (
        <div
          aria-label={ariaLabel}
          className={`menu-content ${contentClassName}`.trim()}
          id={contentId}
          onClick={handleMenuClick}
          onKeyDown={handleMenuKeyDown}
          ref={contentRef}
          role="menu"
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface DropdownMenuItemProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  disabled?: boolean;
  icon?: AppIconName;
  onSelect: () => void;
}

export function DropdownMenuItem({
  children,
  className = "",
  description,
  disabled = false,
  icon,
  onSelect,
}: DropdownMenuItemProps) {
  return (
    <button
      className={`menu-item ${description ? "menu-item-rich" : ""} ${className}`.trim()}
      disabled={disabled}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      {icon && <AppIcon className="menu-item-icon" name={icon} size="sm" />}
      <span className="menu-item-copy">
        <span className="menu-item-label">{children}</span>
        {description && <span className="menu-item-description">{description}</span>}
      </span>
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

import { createPortal } from "react-dom";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
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
  portal?: boolean;
  trigger: (props: DropdownTriggerProps) => ReactNode;
}

function menuItems(container: HTMLDivElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

export function DropdownMenu({
  ariaLabel,
  children,
  className = "",
  contentClassName = "",
  disabled = false,
  portal = false,
  trigger,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null);
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
    menuItems(contentRef.current)[0]?.focus();

    function closeFromOutside(event: PointerEvent) {
      if (
        !rootRef.current?.contains(event.target as Node)
        && !contentRef.current?.contains(event.target as Node)
      ) close();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portal) {
      setPortalStyle(null);
      return;
    }

    function position() {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      const contentRect = contentRef.current?.getBoundingClientRect();
      if (!triggerRect || !contentRect) return;
      const gap = 8;
      const viewportPadding = 8;
      const left = Math.min(
        Math.max(viewportPadding, triggerRect.right - contentRect.width),
        window.innerWidth - contentRect.width - viewportPadding,
      );
      const fitsBelow = triggerRect.bottom + gap + contentRect.height
        <= window.innerHeight - viewportPadding;
      const top = fitsBelow
        ? triggerRect.bottom + gap
        : Math.max(viewportPadding, triggerRect.top - contentRect.height - gap);
      setPortalStyle({ left, top });
    }

    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, portal]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!disabled) setOpen(true);
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = menuItems(contentRef.current);
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
    } else if (event.key === "Tab") {
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (items.length === 0) return;
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

  const content = open && (
    <div
      aria-label={ariaLabel}
      className={`menu-content ${portal ? "menu-content-portal" : ""} ${contentClassName}`.trim()}
      id={contentId}
      onClick={handleMenuClick}
      onKeyDown={handleMenuKeyDown}
      ref={contentRef}
      role="menu"
      style={portal ? { ...portalStyle, visibility: portalStyle ? "visible" : "hidden" } : undefined}
    >
      {children}
    </div>
  );

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
      {portal && content ? createPortal(content, document.body) : content}
    </div>
  );
}

interface DropdownMenuItemProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  icon?: AppIconName;
  onSelect: () => void;
}

export function DropdownMenuItem({
  children,
  className = "",
  description,
  disabled = false,
  danger = false,
  icon,
  onSelect,
}: DropdownMenuItemProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <button
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      aria-disabled={disabled || undefined}
      className={`menu-item ${description ? "menu-item-rich" : ""} ${danger ? "menu-item-danger" : ""} ${className}`.trim()}
      onClick={() => { if (!disabled) onSelect(); }}
      role="menuitem"
      type="button"
    >
      {icon && <AppIcon className="menu-item-icon" name={icon} size="sm" />}
      <span className="menu-item-copy">
        <span className="menu-item-label" id={labelId}>{children}</span>
        {description && <span className="menu-item-description" id={descriptionId}>{description}</span>}
      </span>
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

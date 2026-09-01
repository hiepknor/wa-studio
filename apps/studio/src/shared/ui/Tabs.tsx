import type { KeyboardEvent, ReactNode } from "react";
import "./tabs.css";

export interface TabItem<T extends string> {
  disabled?: boolean;
  id: T;
  label: string;
  meta?: ReactNode;
  warning?: boolean;
}

export interface TabsProps<T extends string> {
  activeTab: T;
  ariaLabel: string;
  idPrefix: string;
  onChange: (tab: T) => void;
  orientation?: "horizontal" | "vertical";
  tabs: readonly TabItem<T>[];
}

export function Tabs<T extends string>({
  activeTab,
  ariaLabel,
  idPrefix,
  onChange,
  orientation = "horizontal",
  tabs,
}: TabsProps<T>) {
  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const direction = orientation === "vertical"
      ? event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
      : event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const enabledIndexes = tabs
      .map((tab, tabIndex) => tab.disabled ? -1 : tabIndex)
      .filter((tabIndex) => tabIndex >= 0);
    const currentEnabledIndex = enabledIndexes.indexOf(index);
    const nextIndex = event.key === "Home"
      ? (enabledIndexes[0] ?? -1)
      : event.key === "End"
        ? (enabledIndexes[enabledIndexes.length - 1] ?? -1)
        : direction && enabledIndexes.length
          ? enabledIndexes[
            (currentEnabledIndex + direction + enabledIndexes.length) % enabledIndexes.length
          ] ?? -1
          : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    onChange(next.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [nextIndex]?.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={`tabs tabs-${orientation}`}
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${idPrefix}-${tab.id}-panel`}
          aria-selected={activeTab === tab.id}
          className="tabs-trigger"
          disabled={tab.disabled}
          id={`${idPrefix}-${tab.id}-tab`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={activeTab === tab.id && !tab.disabled ? 0 : -1}
          type="button"
        >
          <span className="tabs-label">{tab.label}</span>
          {tab.meta !== undefined && (
            <span className="tabs-meta">{tab.meta}</span>
          )}
          {tab.warning && (
            <span aria-label="Attention required" className="tabs-warning" />
          )}
        </button>
      ))}
    </div>
  );
}

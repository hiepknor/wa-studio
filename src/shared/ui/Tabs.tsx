import type { KeyboardEvent, ReactNode } from "react";
import "./tabs.css";

export interface TabItem<T extends string> {
  badge?: ReactNode;
  id: T;
  label: string;
  warning?: boolean;
}

interface TabsProps<T extends string> {
  activeTab: T;
  ariaLabel: string;
  idPrefix: string;
  onChange: (tab: T) => void;
  tabs: readonly TabItem<T>[];
}

export function Tabs<T extends string>({
  activeTab,
  ariaLabel,
  idPrefix,
  onChange,
  tabs,
}: TabsProps<T>) {
  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const direction =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : direction
            ? (index + direction + tabs.length) % tabs.length
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
    <div aria-label={ariaLabel} className="tabs" role="tablist">
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${idPrefix}-${tab.id}-panel`}
          aria-selected={activeTab === tab.id}
          className="tabs-trigger"
          id={`${idPrefix}-${tab.id}-tab`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={activeTab === tab.id ? 0 : -1}
          type="button"
        >
          <span>{tab.label}</span>
          {tab.badge !== undefined && (
            <span className="tabs-badge">{tab.badge}</span>
          )}
          {tab.warning && (
            <span aria-label="Attention required" className="tabs-warning" />
          )}
        </button>
      ))}
    </div>
  );
}

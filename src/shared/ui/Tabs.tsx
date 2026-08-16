import type { KeyboardEvent, ReactNode } from "react";
import "./tabs.css";

export interface TabItem<T extends string> {
  disabled?: boolean;
  id: T;
  label: string;
  meta?: ReactNode;
  step?: number;
  warning?: boolean;
}

interface TabsProps<T extends string> {
  activeTab: T;
  appearance?: "line" | "steps";
  ariaLabel: string;
  idPrefix: string;
  onChange: (tab: T) => void;
  tabs: readonly TabItem<T>[];
}

export function Tabs<T extends string>({
  activeTab,
  appearance = "line",
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
      className={`tabs tabs-${appearance}`}
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${idPrefix}-${tab.id}-panel`}
          aria-current={appearance === "steps" && activeTab === tab.id ? "step" : undefined}
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
          {appearance === "steps" && tab.step !== undefined && (
            <span aria-hidden="true" className="tabs-step-index">{tab.step}</span>
          )}
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

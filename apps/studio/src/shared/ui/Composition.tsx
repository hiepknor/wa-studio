import { createElement, type ReactNode } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import { DataTableScroll } from "./DataTable";
import "./composition.css";

type HeadingLevel = 2 | 3 | 4;

interface SectionHeaderProps {
  action?: ReactNode;
  description?: ReactNode;
  divider?: boolean;
  eyebrow?: ReactNode;
  headingLevel?: HeadingLevel;
  title: ReactNode;
  titleId: string;
}

export function SectionHeader({
  action,
  description,
  divider = true,
  eyebrow,
  headingLevel = 2,
  title,
  titleId,
}: SectionHeaderProps) {
  return (
    <header className="ui-section-header" data-divider={divider || undefined}>
      <div className="ui-section-header-copy">
        {eyebrow && <span className="ui-section-eyebrow">{eyebrow}</span>}
        {createElement(`h${headingLevel}`, { id: titleId }, title)}
        {description && <p>{description}</p>}
      </div>
      {action && <div className="ui-section-header-action">{action}</div>}
    </header>
  );
}

interface SurfacePanelProps {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  flush?: boolean;
  headingLevel?: HeadingLevel;
  title: ReactNode;
  titleId: string;
  variant?: "flat" | "outlined";
}

export function SurfacePanel({
  action,
  children,
  className = "",
  description,
  flush = false,
  headingLevel = 3,
  title,
  titleId,
  variant = "outlined",
}: SurfacePanelProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`ui-surface-panel ${className}`.trim()}
      data-variant={variant}
    >
      <header className="ui-surface-panel-header">
        <div>
          {createElement(`h${headingLevel}`, { id: titleId }, title)}
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="ui-surface-panel-body" data-flush={flush || undefined}>
        {children}
      </div>
    </section>
  );
}

export interface MetricGridItem {
  label: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  value: ReactNode;
}

interface MetricGridProps {
  ariaLabel: string;
  className?: string;
  items: readonly MetricGridItem[];
}

export function MetricGrid({ ariaLabel, className = "", items }: MetricGridProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={`ui-metric-grid ${className}`.trim()}
      role="group"
    >
      {items.map((item, index) => (
        <dl data-tone={item.tone === "default" ? undefined : item.tone} key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </dl>
      ))}
    </div>
  );
}

export interface DescriptionListItem {
  id: string;
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
}

interface DescriptionListProps {
  ariaLabel: string;
  className?: string;
  items: readonly DescriptionListItem[];
}

export function DescriptionList({
  ariaLabel,
  className = "",
  items,
}: DescriptionListProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={`ui-description-list ${className}`.trim()}
      role="group"
    >
      {items.map((item) => (
        <dl key={item.id}>
          <dt>{item.label}</dt>
          <dd className={item.valueClassName}>{item.value}</dd>
        </dl>
      ))}
    </div>
  );
}

export interface EvidenceListItem {
  description?: ReactNode;
  id: string;
  meta?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
}

interface EvidenceListProps {
  ariaLabel: string;
  items: readonly EvidenceListItem[];
}

export function EvidenceList({ ariaLabel, items }: EvidenceListProps) {
  return (
    <ul aria-label={ariaLabel} className="ui-evidence-list">
      {items.map((item) => (
        <li key={item.id}>
          {item.status && <div className="ui-evidence-status">{item.status}</div>}
          <div className="ui-evidence-copy">
            <strong>{item.title}</strong>
            {item.description && <span>{item.description}</span>}
            {item.meta && <span className="ui-evidence-meta">{item.meta}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

interface DataTableFrameProps {
  afterToolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  label: string;
  scroll?: boolean;
  toolbar?: ReactNode;
  variant?: "flush" | "outlined";
}

export function DataTableFrame({
  afterToolbar,
  children,
  className = "",
  footer,
  label,
  scroll = true,
  toolbar,
  variant = "outlined",
}: DataTableFrameProps) {
  return (
    <section
      aria-label={label}
      className={`ui-data-table-frame ${className}`.trim()}
      data-variant={variant}
    >
      {toolbar && <div className="ui-data-table-toolbar">{toolbar}</div>}
      {afterToolbar}
      {scroll ? <DataTableScroll>{children}</DataTableScroll> : children}
      {footer && <div className="ui-data-table-footer">{footer}</div>}
    </section>
  );
}

interface EmptyStateProps {
  children: ReactNode;
  compact?: boolean;
  icon: AppIconName;
  title: ReactNode;
}

export function EmptyState({ children, compact = false, icon, title }: EmptyStateProps) {
  return (
    <div className="ui-empty-state" data-compact={compact || undefined}>
      <span aria-hidden="true" className="ui-empty-state-icon">
        <AppIcon name={icon} size="lg" />
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

interface ActionFooterProps {
  actions: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  title: ReactNode;
}

export function ActionFooter({ actions, description, leading, title }: ActionFooterProps) {
  return (
    <footer className="ui-action-footer">
      {leading && <div className="ui-action-footer-leading">{leading}</div>}
      <div className="ui-action-footer-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="ui-action-footer-actions">{actions}</div>
    </footer>
  );
}

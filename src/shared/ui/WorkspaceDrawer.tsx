import type { ComponentProps, ReactNode } from "react";

import { AppIcon, type AppIconName } from "./AppIcon";
import { Drawer } from "./Drawer";
import "./workspace-drawer.css";

interface WorkspaceDrawerProps
  extends Omit<ComponentProps<typeof Drawer>, "children" | "className" | "footer"> {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  footer?: ReactNode;
  navigation?: ReactNode;
  notice?: ReactNode;
}

export function WorkspaceDrawer({
  children,
  className = "",
  contentClassName = "",
  footer,
  navigation,
  notice,
  ...props
}: WorkspaceDrawerProps) {
  return (
    <Drawer
      {...props}
      className={`workspace-drawer ${className}`.trim()}
      footer={footer}
    >
      <div className="workspace-drawer-layout">
        {notice && <div className="workspace-drawer-notice">{notice}</div>}
        {navigation && (
          <div className="workspace-drawer-navigation">{navigation}</div>
        )}
        <div
          className={`workspace-drawer-content ${contentClassName}`.trim()}
        >
          {children}
        </div>
      </div>
    </Drawer>
  );
}

interface WorkspaceSectionHeaderProps {
  action?: ReactNode;
  description: ReactNode;
  kicker?: ReactNode;
  title: ReactNode;
  titleId?: string;
}

export function WorkspaceSectionHeader({
  action,
  description,
  kicker,
  title,
  titleId,
}: WorkspaceSectionHeaderProps) {
  return (
    <div className="workspace-section-header">
      <div>
        {kicker && <span>{kicker}</span>}
        <h3 id={titleId}>{title}</h3>
        <p>{description}</p>
      </div>
      {action && <div className="workspace-section-header-action">{action}</div>}
    </div>
  );
}

export interface WorkspaceSummaryMetric {
  label: ReactNode;
  value: ReactNode;
}

interface WorkspaceSummaryCardProps {
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  dirty?: boolean;
  icon: AppIconName;
  label: ReactNode;
  metrics?: WorkspaceSummaryMetric[];
  status?: ReactNode;
  title: ReactNode;
  titleId: string;
}

export function WorkspaceSummaryCard({
  children,
  className = "",
  description,
  dirty = false,
  icon,
  label,
  metrics = [],
  status,
  title,
  titleId,
}: WorkspaceSummaryCardProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`workspace-summary-card ${className}`.trim()}
      data-dirty={dirty || undefined}
    >
      <header>
        <span className="workspace-summary-icon">
          <AppIcon name={icon} size="sm" />
        </span>
        <div className="workspace-summary-copy">
          <span>{label}</span>
          <div>
            <h4 id={titleId}>{title}</h4>
            {status}
          </div>
          {description && <p>{description}</p>}
        </div>
        {metrics.length > 0 && (
          <dl className="workspace-summary-metrics">
            {metrics.map((metric, index) => (
              <div key={index}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>
      {children}
    </section>
  );
}

interface WorkspacePanelProps {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  flush?: boolean;
  title: ReactNode;
  titleId: string;
  tone?: "default" | "accent";
}

export function WorkspacePanel({
  action,
  children,
  className = "",
  description,
  flush = false,
  title,
  titleId,
  tone = "default",
}: WorkspacePanelProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`workspace-panel ${className}`.trim()}
      data-tone={tone}
    >
      <header className="workspace-panel-header">
        <div>
          <h4 id={titleId}>{title}</h4>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="workspace-panel-body" data-flush={flush || undefined}>
        {children}
      </div>
    </section>
  );
}

interface WorkspaceFooterProps {
  actions: ReactNode;
  description: ReactNode;
  leading?: ReactNode;
  title: ReactNode;
}

export function WorkspaceFooter({
  actions,
  description,
  leading,
  title,
}: WorkspaceFooterProps) {
  return (
    <div className="workspace-footer" data-has-leading={Boolean(leading) || undefined}>
      {leading && <div className="workspace-footer-leading">{leading}</div>}
      <div className="workspace-footer-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="workspace-footer-actions">{actions}</div>
    </div>
  );
}

interface WorkspaceEmptyStateProps {
  children: ReactNode;
  className?: string;
  compact?: boolean;
  icon: AppIconName;
  loading?: boolean;
  title: ReactNode;
}

export function WorkspaceEmptyState({
  children,
  className = "",
  compact = false,
  icon,
  loading = false,
  title,
}: WorkspaceEmptyStateProps) {
  return (
    <div
      className={`workspace-empty-state ${className}`.trim()}
      data-compact={compact || undefined}
    >
      <span className="workspace-empty-state-icon">
        <AppIcon className={loading ? "ui-icon-spin" : undefined} name={icon} size="lg" />
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

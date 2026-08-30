import type { ComponentProps, ReactNode } from "react";

import { AppIcon } from "./AppIcon";
import { Drawer } from "./Drawer";
import "./inspector-drawer.css";

export interface InspectorDrawerProps
  extends Omit<
    ComponentProps<typeof Drawer>,
    "children" | "className" | "description" | "eyebrow" | "footer" | "subheader"
  > {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  footer?: ReactNode;
  kicker: ReactNode;
  meta?: readonly ReactNode[];
  navigation?: ReactNode;
  status?: ReactNode;
}

export function InspectorDrawer({
  children,
  className = "",
  contentClassName = "",
  footer,
  kicker,
  meta = [],
  navigation,
  status,
  ...props
}: InspectorDrawerProps) {
  const headerMeta = (meta.length > 0 || status) ? (
    <div className="inspector-drawer-header-meta">
      {meta.length > 0 && (
        <span className="inspector-drawer-meta-items">
          {meta.map((item, index) => (
            <span className="inspector-drawer-meta-item" key={index}>
              {index > 0 && <span className="inspector-drawer-meta-separator"> · </span>}
              {item}
            </span>
          ))}
        </span>
      )}
      {meta.length > 0 && status && (
        <span className="inspector-drawer-meta-separator"> · </span>
      )}
      {status && <span className="inspector-drawer-header-status">{status}</span>}
    </div>
  ) : undefined;

  return (
    <Drawer
      {...props}
      className={`inspector-drawer ${className}`.trim()}
      description={headerMeta}
      eyebrow={kicker}
      footer={footer}
      subheader={navigation && (
        <div className="inspector-drawer-navigation">{navigation}</div>
      )}
    >
      <div className="inspector-drawer-layout">
        <div
          className={`inspector-drawer-content ${contentClassName}`.trim()}
        >
          {children}
        </div>
      </div>
    </Drawer>
  );
}

export interface InspectorSectionProps {
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  titleId: string;
}

export function InspectorSection({
  action,
  children,
  className = "",
  description,
  eyebrow,
  title,
  titleId,
}: InspectorSectionProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={`inspector-section ${className}`.trim()}
    >
      <header className="inspector-section-header">
        <div>
          {eyebrow && <span className="inspector-section-eyebrow">{eyebrow}</span>}
          <h3 id={titleId}>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="inspector-section-action">{action}</div>}
      </header>
      {children && <div className="inspector-section-body">{children}</div>}
    </section>
  );
}

export interface InspectorDisclosureProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  title: ReactNode;
  titleId: string;
}

export function InspectorDisclosure({
  children,
  className = "",
  description,
  title,
  titleId,
}: InspectorDisclosureProps) {
  return (
    <details className={`inspector-disclosure ${className}`.trim()}>
      <summary>
        <span>
          <strong id={titleId}>{title}</strong>
          {description && <small>{description}</small>}
        </span>
        <AppIcon
          className="inspector-disclosure-indicator"
          name="chevron-right"
          size="sm"
        />
      </summary>
      <div aria-labelledby={titleId} className="inspector-disclosure-body">
        {children}
      </div>
    </details>
  );
}

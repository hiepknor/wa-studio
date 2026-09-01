import type { ReactNode } from "react";

interface SettingsSectionProps {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  kicker?: string;
  title: ReactNode;
  titleId: string;
}

export function SettingsSection({
  action,
  children,
  className = "",
  description,
  kicker,
  title,
  titleId,
}: SettingsSectionProps) {
  return (
    <section aria-labelledby={titleId} className={`settings-section ${className}`.trim()}>
      <header className="settings-section-header">
        <div className="settings-section-copy">
          {kicker && <span className="settings-card-label">{kicker}</span>}
          <h2 id={titleId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="settings-section-action">{action}</div>}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

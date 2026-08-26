import type { ReactNode } from "react";

interface SettingsRowProps {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  label: ReactNode;
}

export function SettingsRow({
  action,
  className = "",
  description,
  label,
}: SettingsRowProps) {
  return (
    <div className={`settings-row ${className}`.trim()}>
      <div className="settings-row-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </div>
      {action !== undefined && <div className="settings-row-action">{action}</div>}
    </div>
  );
}

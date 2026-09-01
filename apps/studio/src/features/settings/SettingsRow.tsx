import { type ReactNode, useId } from "react";

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
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={labelId}
      className={`settings-row ${className}`.trim()}
      role="group"
    >
      <div className="settings-row-copy">
        <strong id={labelId}>{label}</strong>
        {description && <small id={descriptionId}>{description}</small>}
      </div>
      {action !== undefined && <div className="settings-row-action">{action}</div>}
    </div>
  );
}

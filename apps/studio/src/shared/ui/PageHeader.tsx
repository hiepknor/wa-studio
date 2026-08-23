import type { HTMLAttributes, ReactNode } from "react";

import "./page-header.css";

interface PageHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  actions?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
  titleId?: string;
}

export function PageHeader({
  actions,
  className = "",
  description,
  title,
  titleId,
  ...props
}: PageHeaderProps) {
  return (
    <div {...props} className={`page-header ${className}`.trim()}>
      <div className="page-header-copy">
        <h2 className="page-header-title" id={titleId}>{title}</h2>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

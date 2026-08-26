import type { ReactNode } from "react";

import { AppIcon } from "@/shared/ui/AppIcon";
import { BrandMark } from "@/shared/ui/BrandMark";

interface ConnectionShellProps {
  buildLabel: ReactNode;
  children: ReactNode;
  description: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  titleId: string;
  trustNote: ReactNode;
}

export function ConnectionShell({
  buildLabel,
  children,
  description,
  eyebrow,
  title,
  titleId,
  trustNote,
}: ConnectionShellProps) {
  return (
    <main className="shell connection-shell">
      <header className="connection-brand">
        <BrandMark />
        <strong>WA Studio</strong>
        <span className="connection-build">{buildLabel}</span>
      </header>
      <div className="connection-stage">
        <section aria-labelledby={titleId} className="connection-intro">
          <span className="eyebrow">{eyebrow}</span>
          <h1 id={titleId}>{title}</h1>
          <p>{description}</p>
          <div className="connection-trust-note">
            <AppIcon name="info" size="sm" />
            <span>{trustNote}</span>
          </div>
        </section>
        {children}
      </div>
    </main>
  );
}

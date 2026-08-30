import type { ComponentProps, ReactNode } from "react";

import { ModalDialog } from "./ModalDialog";
import "./workspace-drawer.css";
import "./workspace-dialog.css";

export interface WorkspaceDialogProps
  extends Omit<
    ComponentProps<typeof ModalDialog>,
    "bodyClassName" | "children" | "className" | "footer" | "size"
  > {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  footer?: ReactNode;
  navigation?: ReactNode;
  notice?: ReactNode;
}

export function WorkspaceDialog({
  children,
  className = "",
  contentClassName = "",
  footer,
  navigation,
  notice,
  ...props
}: WorkspaceDialogProps) {
  return (
    <ModalDialog
      {...props}
      bodyClassName="workspace-dialog-body"
      className={`workspace-dialog ${className}`.trim()}
      footer={footer}
      size="workflow"
    >
      <div className="workspace-dialog-layout">
        {navigation && (
          <div className="workspace-dialog-navigation">{navigation}</div>
        )}
        {notice && <div className="workspace-dialog-notice">{notice}</div>}
        <div
          className={`workspace-dialog-content ${contentClassName}`.trim()}
        >
          {children}
        </div>
      </div>
    </ModalDialog>
  );
}

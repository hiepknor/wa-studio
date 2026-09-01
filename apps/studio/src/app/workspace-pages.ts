export type WorkspacePageId =
  | "groups"
  | "campaigns"
  | "runs"
  | "activity"
  | "sessions"
  | "settings";

export interface WorkspacePageDefinition {
  available: boolean;
  id: WorkspacePageId;
  label: string;
}

export interface WorkspaceSectionDefinition {
  id: "workspaces" | "operations";
  label: string;
  pages: readonly WorkspacePageDefinition[];
}

export const DEFAULT_WORKSPACE_PAGE: WorkspacePageId = "groups";

export const SETTINGS_WORKSPACE_PAGE: WorkspacePageDefinition = {
  available: true,
  id: "settings",
  label: "Settings",
};

export const WORKSPACE_SECTIONS: readonly WorkspaceSectionDefinition[] = [
  {
    id: "workspaces",
    label: "Workspace",
    pages: [
      { available: true, id: "sessions", label: "Sessions" },
      { available: true, id: "groups", label: "Groups" },
      { available: true, id: "campaigns", label: "Campaigns" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    pages: [
      { available: true, id: "runs", label: "Runs" },
      { available: true, id: "activity", label: "Activity" },
    ],
  },
];

export function findWorkspacePage(pageId: WorkspacePageId): WorkspacePageDefinition {
  const page = pageId === SETTINGS_WORKSPACE_PAGE.id
    ? SETTINGS_WORKSPACE_PAGE
    : WORKSPACE_SECTIONS.flatMap((section) => section.pages).find(
      (candidate) => candidate.id === pageId,
    );
  if (!page) throw new Error(`Unknown workspace page: ${pageId}`);
  return page;
}

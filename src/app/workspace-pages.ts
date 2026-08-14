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
  id: "operate" | "system";
  label: string;
  pages: readonly WorkspacePageDefinition[];
}

export const DEFAULT_WORKSPACE_PAGE: WorkspacePageId = "sessions";

export const WORKSPACE_SECTIONS: readonly WorkspaceSectionDefinition[] = [
  {
    id: "operate",
    label: "Operate",
    pages: [
      { available: true, id: "groups", label: "Groups" },
      { available: true, id: "campaigns", label: "Campaigns" },
      { available: false, id: "runs", label: "Runs" },
      { available: false, id: "activity", label: "Activity" },
    ],
  },
  {
    id: "system",
    label: "System",
    pages: [
      { available: true, id: "sessions", label: "Sessions" },
      { available: false, id: "settings", label: "Settings" },
    ],
  },
];

export function findWorkspacePage(pageId: WorkspacePageId): WorkspacePageDefinition {
  const page = WORKSPACE_SECTIONS.flatMap((section) => section.pages).find(
    (candidate) => candidate.id === pageId,
  );
  if (!page) throw new Error(`Unknown workspace page: ${pageId}`);
  return page;
}

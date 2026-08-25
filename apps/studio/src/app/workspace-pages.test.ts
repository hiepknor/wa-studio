import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_PAGE,
  SETTINGS_WORKSPACE_PAGE,
  findWorkspacePage,
  WORKSPACE_SECTIONS,
} from "./workspace-pages";

describe("workspace page registry", () => {
  it("uses one unique id per page and keeps the default page available", () => {
    const pages = [
      ...WORKSPACE_SECTIONS.flatMap((section) => section.pages),
      SETTINGS_WORKSPACE_PAGE,
    ];

    expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
    expect(findWorkspacePage(DEFAULT_WORKSPACE_PAGE).available).toBe(true);
    expect(findWorkspacePage("groups").available).toBe(true);
  });

  it("matches the prototype rail hierarchy and keeps Settings in the footer", () => {
    expect(WORKSPACE_SECTIONS.find((section) => section.id === "workspaces")?.pages.map((page) => page.id))
      .toEqual(["sessions", "groups", "campaigns"]);
    expect(WORKSPACE_SECTIONS.find((section) => section.id === "operations")?.pages.map((page) => page.id))
      .toEqual(["runs", "activity"]);
    expect(SETTINGS_WORKSPACE_PAGE.id).toBe("settings");
  });
});

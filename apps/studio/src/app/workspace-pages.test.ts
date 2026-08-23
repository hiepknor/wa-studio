import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_PAGE,
  findWorkspacePage,
  WORKSPACE_SECTIONS,
} from "./workspace-pages";

describe("workspace page registry", () => {
  it("uses one unique id per page and keeps the default page available", () => {
    const pages = WORKSPACE_SECTIONS.flatMap((section) => section.pages);

    expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
    expect(findWorkspacePage(DEFAULT_WORKSPACE_PAGE).available).toBe(true);
    expect(findWorkspacePage("groups").available).toBe(true);
  });

  it("separates operational pages from system configuration", () => {
    expect(WORKSPACE_SECTIONS.find((section) => section.id === "operate")?.pages.map((page) => page.id))
      .toEqual(["groups", "campaigns", "runs", "activity"]);
    expect(WORKSPACE_SECTIONS.find((section) => section.id === "system")?.pages.map((page) => page.id))
      .toEqual(["sessions", "settings"]);
  });
});

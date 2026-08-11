import { KeyboardEvent, useEffect, useRef, useState } from "react";

import { useRuntimeConnection } from "./RuntimeConnectionContext";
import { SessionSwitcher } from "./SessionSwitcher";
import {
  DEFAULT_WORKSPACE_PAGE,
  WORKSPACE_SECTIONS,
  type WorkspacePageId,
} from "./workspace-pages";
import { SessionsScreen } from "@/features/sessions/SessionsScreen";
import { AppIcon, type AppIconName } from "@/shared/ui/AppIcon";
import { BrandMark } from "@/shared/ui/BrandMark";
import { Button } from "@/shared/ui/Button";

const PAGE_ICONS: Record<WorkspacePageId, AppIconName> = {
  activity: "activity",
  campaigns: "campaigns",
  groups: "groups",
  runs: "runs",
  sessions: "sessions",
  settings: "settings",
};

function sessionTone(status: string | undefined): "ok" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "ok";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function formatSyncTime(value: string | null | undefined): string {
  if (!value) return "not synced";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function renderPage(pageId: WorkspacePageId) {
  switch (pageId) {
    case "sessions":
      return <SessionsScreen />;
    default:
      throw new Error(`Workspace page is not implemented: ${pageId}`);
  }
}

export function WorkspaceShell() {
  const {
    connected,
    disconnect,
    selectedSessionId,
    selectSession,
  } = useRuntimeConnection();
  const [activePage, setActivePage] = useState<WorkspacePageId>(DEFAULT_WORKSPACE_PAGE);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const runtimeMenuRef = useRef<HTMLDivElement>(null);
  const runtimeMenuButtonRef = useRef<HTMLButtonElement>(null);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!runtimeMenuOpen) return;
    disconnectButtonRef.current?.focus();

    function closeFromOutside(event: PointerEvent) {
      if (!runtimeMenuRef.current?.contains(event.target as Node)) {
        setRuntimeMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [runtimeMenuOpen]);

  function closeRuntimeMenu({ restoreFocus = false } = {}) {
    setRuntimeMenuOpen(false);
    if (restoreFocus) runtimeMenuButtonRef.current?.focus();
  }

  function handleRuntimeTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setRuntimeMenuOpen(true);
  }

  function handleRuntimeMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRuntimeMenu({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      closeRuntimeMenu();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      disconnectButtonRef.current?.focus();
    }
  }

  if (!connected) throw new Error("WorkspaceShell requires a Runtime connection");

  const selectedSession =
    connected.sessions.find((session) => session.id === selectedSessionId) ?? null;
  const sessionCountLabel = `${connected.sessions.length} Gateway ${
    connected.sessions.length === 1 ? "session" : "sessions"
  }`;
  const activePageLabel = WORKSPACE_SECTIONS.flatMap((section) => section.pages).find(
    (page) => page.id === activePage,
  )?.label;

  return (
    <main className="workspace">
      <aside className="workspace-sidebar">
        <div className="workspace-brand-lockup">
          <BrandMark />
          <span>
            <strong className="workspace-brand">WA Studio</strong>
            <small>runtime workspace</small>
          </span>
        </div>

        <nav aria-label="Workspace navigation" className="workspace-navigation">
          {WORKSPACE_SECTIONS.map((section) => (
            <section className="workspace-nav-section" key={section.id}>
              <strong className="workspace-nav-label">{section.label}</strong>
              <div className="stack stack-xs">
                {section.pages.map((page) => (
                  <button
                    aria-current={page.id === activePage ? "page" : undefined}
                    className="workspace-nav-button"
                    data-variant={page.id === activePage ? "secondary" : "quiet"}
                    disabled={!page.available}
                    key={page.id}
                    onClick={() => setActivePage(page.id)}
                    title={page.available ? undefined : `${page.label} is planned for a later slice`}
                    type="button"
                  >
                    <AppIcon className="workspace-nav-icon" name={PAGE_ICONS[page.id]} />
                    <span className="workspace-nav-text">{page.label}</span>
                    {!page.available && (
                      <span aria-hidden="true" className="workspace-nav-meta">soon</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </nav>

        <div className="workspace-runtime-summary">
          <span className="workspace-runtime-label">Runtime status</span>
          <span className={`status-mark status-${sessionTone(selectedSession?.status)}`}>
            {selectedSession?.status === "ready" ? "Operational" : "Attention required"}
          </span>
          <span className="workspace-runtime-meta">{sessionCountLabel}</span>
        </div>
      </aside>

      <div className="workspace-main">
        <header aria-label="Workspace toolbar" className="workspace-toolbar">
          <div className="workspace-toolbar-context">
            <span className="workspace-toolbar-copy">
              <span className="workspace-breadcrumb">WA Studio</span>
              <strong className="workspace-current-page">{activePageLabel}</strong>
            </span>
          </div>

          <div className="workspace-toolbar-actions">
            <SessionSwitcher
              onSelect={selectSession}
              selectedSessionId={selectedSessionId}
              sessions={connected.sessions}
            />

            <div className="menu" ref={runtimeMenuRef}>
              <button
                aria-expanded={runtimeMenuOpen}
                aria-haspopup="menu"
                className="workspace-runtime-button"
                data-tone={sessionTone(selectedSession?.status)}
                onClick={() => setRuntimeMenuOpen((open) => !open)}
                onKeyDown={handleRuntimeTriggerKeyDown}
                ref={runtimeMenuButtonRef}
                type="button"
              >
                <span aria-hidden="true" className="workspace-runtime-indicator" />
                <span className="workspace-runtime-text">Runtime</span>
                <AppIcon className="workspace-runtime-chevron" name="chevron-down" size="xs" />
              </button>
              {runtimeMenuOpen && (
                <div
                  aria-label="Runtime connection"
                  className="menu-content"
                  onKeyDown={handleRuntimeMenuKeyDown}
                  role="menu"
                >
                  <div className="runtime-menu-context" role="presentation">
                    <span>Runtime endpoint</span>
                    <code>{connected.profile.baseUrl}</code>
                  </div>
                  <div className="menu-separator" role="separator" />
                  <Button
                    className="menu-item"
                    onClick={() => {
                      closeRuntimeMenu();
                      disconnect();
                    }}
                    ref={disconnectButtonRef}
                    role="menuitem"
                    size="sm"
                    type="button"
                    variant="danger"
                  >
                    Disconnect Runtime
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="workspace-body">
          <section aria-labelledby={`${activePage}-title`} className="workspace-content">
            {renderPage(activePage)}
          </section>
        </div>

        <footer className="status-bar">
          <span><span className="status-bar-dot" />Connected to {connected.profile.baseUrl}</span>
          <span className="status-bar-session">session: {selectedSession?.name ?? "none"}</span>
          <span>Last sync: {formatSyncTime(selectedSession?.syncedAt)}</span>
        </footer>
      </div>
    </main>
  );
}

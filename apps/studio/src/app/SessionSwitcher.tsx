import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { RuntimeSession } from "@/shared/api/runtime-client";
import { sessionIdentityLabel } from "@/shared/presentation/session";
import { AppIcon } from "@/shared/ui/AppIcon";
import { DateTime } from "@/shared/ui/DateTime";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";
import { StatusDot } from "@/shared/ui/StatusDot";

interface SessionSwitcherProps {
  onManageSessions: () => void;
  onSelect: (sessionId: string) => void;
  selectedSessionId: string | null;
  sessions: RuntimeSession[];
}

function nextIndex(current: number, direction: 1 | -1, length: number) {
  return (current + direction + length) % length;
}

function sessionTone(status: string): FeedbackTone {
  if (status === "ready") return "success";
  if (status === "failed" || status === "disconnected") return "danger";
  if (status === "initializing" || status === "authenticating") return "warning";
  return "neutral";
}

function SessionStatus({ className, status }: { className: string; status: string }) {
  const tone = sessionTone(status);
  return (
    <span className={`workspace-session-status ${className}`} data-tone={tone}>
      <StatusDot tone={tone} />
      <span>{status}</span>
    </span>
  );
}

export function SessionSwitcher({
  onManageSessions,
  onSelect,
  selectedSessionId,
  sessions,
}: SessionSwitcherProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filteredSessions = sessions.filter((session) => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return true;
    return [session.name, session.id, sessionIdentityLabel(session)]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const highlightedSession = filteredSessions[highlightedIndex] ?? null;

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlightedIndex((current) => filteredSessions.length === 0
      ? 0
      : Math.min(current, filteredSessions.length - 1));
  }, [filteredSessions.length, open]);

  useEffect(() => {
    if (sessions.length === 0) {
      setOpen(false);
      setQuery("");
    }
  }, [sessions.length]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  function openSelector(initialIndex?: number) {
    setQuery("");
    setHighlightedIndex(
      initialIndex ?? Math.max(sessions.findIndex((session) => session.id === selectedSessionId), 0),
    );
    setOpen(true);
  }

  function close(restoreFocus = true) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(session: RuntimeSession | null) {
    if (!session) return;
    onSelect(session.id);
    close();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (sessions.length === 0) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      openSelector();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openSelector(sessions.length - 1);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (filteredSessions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) =>
        nextIndex(current, event.key === "ArrowDown" ? 1 : -1, filteredSessions.length),
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(event.key === "Home" ? 0 : filteredSessions.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(highlightedSession);
    }
  }

  return (
    <div className="workspace-session-switcher" ref={rootRef}>
      <span className="workspace-session-label" id={`${listboxId}-label`}>Active session</span>
      <button
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Active session"
        className="workspace-session-trigger"
        disabled={sessions.length === 0}
        onClick={() => open ? close(false) : openSelector()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        {selectedSession ? (
          <span className="workspace-session-value">
            <AppIcon name="sessions" size="sm" />
            <span id={`${listboxId}-value`}>{selectedSession.name}</span>
          </span>
        ) : (
          <span className="workspace-session-placeholder" id={`${listboxId}-value`}>
            No session
          </span>
        )}
        <AppIcon className="workspace-session-chevron" name="chevron-down" size="xs" />
      </button>

      {open && (
        <div className="workspace-session-options">
          <div className="workspace-session-search focus-owner">
            <AppIcon name="search" size="sm" />
            <input
              aria-activedescendant={highlightedSession
                ? `${listboxId}-option-${sessions.indexOf(highlightedSession)}`
                : undefined}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded="true"
              aria-label="Search sessions"
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setHighlightedIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search sessions"
              ref={searchRef}
              role="combobox"
              type="search"
              value={query}
            />
          </div>
          <div aria-label="Gateway sessions" className="workspace-session-list" id={listboxId} role="listbox">
            {filteredSessions.length === 0 && (
              <div className="workspace-session-empty" role="option" aria-disabled="true">
                No sessions match this search
              </div>
            )}
            {filteredSessions.map((session, index) => {
              const selected = session.id === selectedSessionId;
              const highlighted = index === highlightedIndex;
              const identity = sessionIdentityLabel(session);
              return (
                <button
                  aria-selected={selected}
                  className="workspace-session-option"
                  data-highlighted={highlighted || undefined}
                  id={`${listboxId}-option-${sessions.indexOf(session)}`}
                  key={session.id}
                  onClick={() => choose(session)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  role="option"
                  tabIndex={-1}
                  type="button"
                >
                  <span aria-hidden="true" className="workspace-session-check">
                    {selected && <AppIcon name="check" size="sm" />}
                  </span>
                  <span className="workspace-session-option-copy">
                    <strong>{session.name}</strong>
                    <span className="workspace-session-option-meta">
                      <span className="workspace-session-identity" title={identity}>{identity}</span>
                      <span>Last activity <DateTime fallback="unknown" value={session.lastActiveAt} /></span>
                    </span>
                  </span>
                  <SessionStatus
                    className="workspace-session-option-status"
                    status={session.status}
                  />
                </button>
              );
            })}
          </div>
          <div className="workspace-session-panel-action">
            <button
              className="workspace-session-manage"
              onClick={() => {
                close(false);
                onManageSessions();
              }}
              type="button"
            >
              <AppIcon name="settings" size="sm" />
              <span>Manage sessions</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import type { RuntimeSession } from "@/shared/api/runtime-client";
import { sessionIdentityLabel } from "@/shared/presentation/session";
import { AppIcon } from "@/shared/ui/AppIcon";
import type { FeedbackTone } from "@/shared/ui/feedback-tone";
import { StatusDot } from "@/shared/ui/StatusDot";

interface SessionSwitcherProps {
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
  onSelect,
  selectedSessionId,
  sessions,
}: SessionSwitcherProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef({ query: "", timestamp: 0 });
  const selectedIndex = sessions.findIndex((session) => session.id === selectedSessionId);
  const selectedSession = selectedIndex >= 0 ? sessions[selectedIndex] : null;
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(Math.max(selectedIndex, 0));

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    return () => document.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (open) setHighlightedIndex(Math.max(selectedIndex, 0));
  }, [open, selectedIndex]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(index: number) {
    const session = sessions[index];
    if (!session) return;
    onSelect(session.id);
    close();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (sessions.length === 0) return;

    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(highlightedIndex);
      else setOpen(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlightedIndex((current) =>
        nextIndex(current, event.key === "ArrowDown" ? 1 : -1, sessions.length),
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(event.key === "Home" ? 0 : sessions.length - 1);
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query = `${now - previous.timestamp < 700 ? previous.query : ""}${event.key}`
        .toLocaleLowerCase();
      typeaheadRef.current = { query, timestamp: now };
      const match = sessions.findIndex((session) =>
        session.name.toLocaleLowerCase().startsWith(query),
      );
      if (match >= 0) {
        event.preventDefault();
        setOpen(true);
        setHighlightedIndex(match);
      }
    }
  }

  return (
    <div className="workspace-session-switcher" ref={rootRef}>
      <span className="workspace-session-label">Active session</span>
      <button
        aria-activedescendant={open ? `${listboxId}-option-${highlightedIndex}` : undefined}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Active session"
        className="workspace-session-trigger"
        disabled={sessions.length === 0}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        {selectedSession ? (
          <span className="workspace-session-value">
            <span>{selectedSession.name}</span>
            <SessionStatus
              className="workspace-session-state"
              status={selectedSession.status}
            />
          </span>
        ) : (
          <span className="workspace-session-placeholder">No session</span>
        )}
        <AppIcon className="workspace-session-chevron" name="chevron-down" size="xs" />
      </button>

      {open && (
        <div aria-label="Gateway sessions" className="workspace-session-options" id={listboxId} role="listbox">
          <div className="workspace-session-options-label" role="presentation">
            Gateway sessions <span>{sessions.length}</span>
          </div>
          {sessions.map((session, index) => {
            const selected = session.id === selectedSessionId;
            const highlighted = index === highlightedIndex;
            const identity = sessionIdentityLabel(session);
            return (
              <div
                aria-selected={selected}
                className="workspace-session-option"
                data-highlighted={highlighted || undefined}
                id={`${listboxId}-option-${index}`}
                key={session.id}
                onClick={() => choose(index)}
                onMouseEnter={() => setHighlightedIndex(index)}
                role="option"
              >
                <span className="workspace-session-option-copy">
                  <strong>{session.name}</strong>
                  <small title={identity}>{identity}</small>
                </span>
                <SessionStatus
                  className="workspace-session-option-status"
                  status={session.status}
                />
                <span aria-hidden="true" className="workspace-session-check">
                  {selected && <AppIcon name="check" size="sm" />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

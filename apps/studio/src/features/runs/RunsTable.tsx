import type { ReactNode } from "react";

import type { RuntimeCampaignRunSummary } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DateTime } from "@/shared/ui/DateTime";
import { DataTablePrimaryAction } from "@/shared/ui/DataTablePrimaryAction";
import {
  resolvedTargets,
  runStatusLabel,
  runTone,
  shortId,
} from "./run-presentation";

interface RunsTableProps {
  emptyAction?: ReactNode;
  emptyMessage: string;
  loading: boolean;
  onInspect: (run: RuntimeCampaignRunSummary) => void;
  runs: readonly RuntimeCampaignRunSummary[];
  selectedRunId: string | null;
  updating?: boolean;
}

export function RunsTable({
  emptyAction,
  emptyMessage,
  loading,
  onInspect,
  runs,
  selectedRunId,
  updating = false,
}: RunsTableProps) {
  const tableMessage = loading && runs.length === 0
    ? "Loading campaign runs…"
    : runs.length === 0
      ? emptyMessage
      : null;

  return (
    <div
      aria-busy={loading || updating}
      className="data-table-scroll runs-table-scroll"
      data-updating={(updating && runs.length > 0) || undefined}
    >
      <table className="data-table runs-table">
        <caption>Campaign runs for the active session</caption>
        <colgroup>
          <col className="runs-column-campaign" />
          <col className="runs-column-state" />
          <col className="runs-column-progress" />
          <col className="runs-column-mode" />
          <col className="runs-column-updated" />
          <col className="runs-column-action" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th className="data-cell-status" scope="col">State</th>
            <th scope="col">Progress</th>
            <th className="runs-mode-col priority-low" scope="col">Mode</th>
            <th className="data-column-time" scope="col">Updated</th>
            <th aria-label="Inspect" className="data-column-actions" scope="col" />
          </tr>
        </thead>
        <tbody>
          {tableMessage ? (
            <tr><td className="data-table-empty" colSpan={6}>
              <div className="data-table-empty-state">
                <span>{tableMessage}</span>
                {!loading && emptyAction}
              </div>
            </td></tr>
          ) : runs.map((run) => {
            const resolved = resolvedTargets(run);
            const attention = run.progress.failed + run.progress.blocked;
            const statusReason = run.statusReason
              ?.replace(/_/g, " ")
              .toLocaleLowerCase();
            return (
              <tr data-selected={run.id === selectedRunId || undefined} key={run.id}>
                <td className="data-cell-primary">
                  <div className="stack stack-xs">
                    <DataTablePrimaryAction onClick={() => onInspect(run)}>{run.campaignNameSnapshot}</DataTablePrimaryAction>
                    <span className="data-identifier">Run {shortId(run.id)} · Campaign {shortId(run.campaignId)}</span>
                  </div>
                </td>
                <td className="data-cell-status">
                  <Badge tone={runTone(run.status)} variant="status">{runStatusLabel(run.status)}</Badge>
                  {statusReason && <span className="runs-status-reason" title={statusReason}>{statusReason}</span>}
                </td>
                <td>
                  <div className="run-progress">
                    <progress aria-label={`${resolved} of ${run.totalTargets} targets resolved`} max={Math.max(1, run.totalTargets)} value={resolved} />
                    <span className="data-cell-value">{resolved}/{run.totalTargets}{attention ? ` · ${attention} attention` : ""}</span>
                  </div>
                </td>
                <td className="data-cell-value runs-mode-col priority-low">{run.executionMode === "LIVE" ? "Live" : "Dry run"}</td>
                <td className="data-cell-time"><DateTime relativeStyle="compact" value={run.updatedAt} variant="relative" /></td>
                <td className="data-cell-action">
                  <Button aria-label={`Inspect run ${shortId(run.id)}`} icon="chevron-right" onClick={() => onInspect(run)} variant="ghost" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

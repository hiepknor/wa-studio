import type { RuntimeGroup } from "@/shared/api/runtime-client";
import { Badge } from "@/shared/ui/Badge";
import { StatusIndicator, type StatusTone } from "@/shared/ui/StatusIndicator";

type GroupCapability = RuntimeGroup["sendCapability"];

export interface GroupCapabilityPresentation {
  accessibleLabel: string;
  label: string;
  stale: boolean;
  statusLabel: "Allowed" | "Denied" | "Unknown";
  tone: StatusTone;
}

export function groupCapabilityIsStale(capability: GroupCapability): boolean {
  if (!capability.invalidatedAt) return false;
  if (!capability.checkedAt) return true;
  return new Date(capability.invalidatedAt) >= new Date(capability.checkedAt);
}

export function getGroupCapabilityPresentation(
  capability: GroupCapability,
): GroupCapabilityPresentation {
  const stale = groupCapabilityIsStale(capability);
  const statusLabel = capability.status === "ALLOWED"
    ? "Allowed"
    : capability.status === "DENIED"
      ? "Denied"
      : "Unknown";
  const tone = stale || capability.status === "UNKNOWN"
    ? "warning"
    : capability.status === "ALLOWED"
      ? "success"
      : "danger";

  return {
    accessibleLabel: `${statusLabel}, ${stale ? "stale" : "current"}`,
    label: stale ? `${statusLabel} · stale` : statusLabel,
    stale,
    statusLabel,
    tone,
  };
}

interface GroupCapabilityStatusProps {
  appearance?: "badge" | "indicator";
  capability: GroupCapability;
  includeFreshness?: boolean;
}

export function GroupCapabilityStatus({
  appearance = "indicator",
  capability,
  includeFreshness = true,
}: GroupCapabilityStatusProps) {
  const presentation = getGroupCapabilityPresentation(capability);
  const label = includeFreshness ? presentation.label : presentation.statusLabel;

  if (appearance === "badge") {
    return (
      <Badge aria-label={presentation.accessibleLabel} tone={presentation.tone}>
        {label}
      </Badge>
    );
  }

  return (
    <StatusIndicator aria-label={presentation.accessibleLabel} glow tone={presentation.tone}>
      {label}
    </StatusIndicator>
  );
}

import {
  GroupSelectionToolbar,
  type GroupSelectionToolbarProps,
} from "@/features/groups/selection/GroupSelectionToolbar";

export {
  activeGroupSelectionFilterCount as activeCampaignTargetFilterCount,
  emptyGroupSelectionFilters as emptyCampaignTargetFilters,
  validateParticipantRange,
  type GroupSelectionFilters as CampaignTargetFilters,
  type ParticipantFilterErrors,
} from "@/features/groups/selection/GroupSelectionToolbar";

export function CampaignTargetToolbar(props: GroupSelectionToolbarProps) {
  return (
    <GroupSelectionToolbar
      filterAriaLabel="Target group filters"
      filterTitle="Filter target groups"
      idPrefix="campaign-target"
      searchLabel="Find target groups"
      {...props}
    />
  );
}

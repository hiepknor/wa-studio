import { Button } from "@/shared/ui/Button";
import { AppIcon } from "@/shared/ui/AppIcon";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/shared/ui/DropdownMenu";

interface GroupBulkActionBarProps {
  actionDisabled?: boolean;
  disabled?: boolean;
  existingListsState?: "available" | "empty" | "loading" | "unavailable";
  listName?: string;
  mode: "add" | "remove";
  onAddExisting: () => void;
  onClear: () => void;
  onCreate: () => void;
  onRemove: () => void;
  selectedCount: number;
}

export function GroupBulkActionBar({
  actionDisabled,
  disabled = false,
  existingListsState = "available",
  listName,
  mode,
  onAddExisting,
  onClear,
  onCreate,
  onRemove,
  selectedCount,
}: GroupBulkActionBarProps) {
  if (selectedCount === 0) return null;
  const mutationDisabled = actionDisabled ?? disabled;
  return (
    <section
      aria-label="Selected groups actions"
      className="data-selection-bar group-bulk-action-bar"
      data-active="true"
    >
      <div aria-live="polite" className="data-selection-summary group-bulk-action-summary">
        <strong>{selectedCount.toLocaleString()} selected</strong>
        <span>
          {mode === "remove"
            ? `Selected from ${listName}`
            : existingListsState === "empty"
              ? "Create the first saved list"
              : "Choose a saved-list destination"}
        </span>
      </div>
      <div className="data-selection-actions group-bulk-action-controls">
        <Button disabled={disabled} onClick={onClear} size="sm" variant="ghost">
          Clear
        </Button>
        {mode === "add" && existingListsState === "empty" ? (
          <Button
            disabled={mutationDisabled}
            icon="list-plus"
            onClick={onCreate}
            size="sm"
            variant="primary"
          >
            New list
          </Button>
        ) : mode === "add" ? (
          <DropdownMenu
            ariaLabel="Add selected groups to a list"
            disabled={mutationDisabled}
            portal
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                className="group-bulk-add-trigger"
                disabled={mutationDisabled}
                size="sm"
                variant="primary"
              >
                <span>Add to list</span>
                <AppIcon name="chevron-down" size="xs" />
              </Button>
            )}
          >
            <DropdownMenuItem
              description={existingListsState === "loading"
                ? "Checking saved lists in this session…"
                : existingListsState === "unavailable"
                  ? "Saved lists could not be loaded."
                  : "Choose one of the saved lists in this session."}
              disabled={existingListsState !== "available"}
              icon="groups"
              onSelect={onAddExisting}
            >
              Add to existing list…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              description="Create a list containing the current selection."
              icon="list-plus"
              onSelect={onCreate}
            >
              Create new list…
            </DropdownMenuItem>
          </DropdownMenu>
        ) : (
          <Button
            disabled={mutationDisabled}
            onClick={onRemove}
            size="sm"
            variant="danger"
          >
            Remove from {listName}
          </Button>
        )}
      </div>
    </section>
  );
}

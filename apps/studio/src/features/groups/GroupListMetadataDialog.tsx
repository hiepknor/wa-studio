import { useRef } from "react";

import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { ModalDialog } from "@/shared/ui/ModalDialog";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";
import {
  groupListMetadataDirty,
  type GroupListMetadataDraft,
} from "./groups-workspace-state";

interface GroupListMetadataDialogProps {
  draft: GroupListMetadataDraft | null;
  fieldErrors: Record<string, string | undefined>;
  hasUnconfirmedCreateIntent: boolean;
  onClose: () => void;
  onRestoreUnconfirmedCreateIntent: () => void;
  onSave: () => void;
  onUpdate: (metadata: { description: string; name: string }) => void;
  saveError: { body: string; title: string } | null;
  saving: boolean;
}

export function GroupListMetadataDialog({
  draft,
  fieldErrors,
  hasUnconfirmedCreateIntent,
  onClose,
  onRestoreUnconfirmedCreateIntent,
  onSave,
  onUpdate,
  saveError,
  saving,
}: GroupListMetadataDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const create = draft?.mode === "create";
  const canSave = Boolean(draft?.name.trim())
    && (create || Boolean(draft && groupListMetadataDirty(draft)));

  return (
    <ModalDialog
      className="group-list-metadata-dialog"
      closeDisabled={saving}
      description={create
        ? draft?.source === "selection"
          ? `Name the list that will contain ${draft.memberIds.length.toLocaleString()} selected ${draft.memberIds.length === 1 ? "group" : "groups"}.`
          : "Name this reusable static group list."
        : "Update list details. Membership is managed from the groups table."}
      footer={(
        <div className="group-list-metadata-actions">
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            disabled={!canSave || saving}
            loading={saving}
            onClick={onSave}
            variant="primary"
          >
            {create
              ? draft?.source === "selection" ? "Create and add" : "Create list"
              : "Save changes"}
          </Button>
        </div>
      )}
      initialFocusRef={nameRef}
      onClose={onClose}
      open={Boolean(draft)}
      title={create ? "New list" : "Edit list"}
    >
      {draft && (
        <form
          className="group-list-metadata-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !saving) onSave();
          }}
        >
          <TextField
            autoComplete="off"
            error={fieldErrors.name}
            label="Name"
            maxLength={120}
            onChange={(event) => onUpdate({
              description: draft.description,
              name: event.target.value,
            })}
            placeholder="e.g. Founder education — core"
            ref={nameRef}
            value={draft.name}
          />
          <TextAreaField
            error={fieldErrors.description}
            label="Description · Optional"
            maxLength={500}
            onChange={(event) => onUpdate({
              description: event.target.value,
              name: draft.name,
            })}
            placeholder="Explain when this list should be used"
            rows={3}
            value={draft.description}
          />
          {(saveError || fieldErrors.groupIds) && (
            <InlineAlert
              action={hasUnconfirmedCreateIntent ? (
                <Button
                  disabled={saving}
                  onClick={onRestoreUnconfirmedCreateIntent}
                  size="sm"
                  variant="ghost"
                >
                  Restore request
                </Button>
              ) : undefined}
              title={saveError?.title ?? "Could not create group list"}
              tone="warning"
            >
              {saveError?.body ?? fieldErrors.groupIds}
            </InlineAlert>
          )}
        </form>
      )}
    </ModalDialog>
  );
}

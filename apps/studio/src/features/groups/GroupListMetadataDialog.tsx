import { useEffect, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";
import { ModalDialog } from "@/shared/ui/ModalDialog";
import { TextAreaField } from "@/shared/ui/TextAreaField";
import { TextField } from "@/shared/ui/TextField";

interface GroupListMetadataDialogProps {
  continueLabel?: string;
  dialogDescription?: string;
  eyebrow?: string;
  initialDescription?: string;
  initialName?: string;
  notice?: string;
  onClose: () => void;
  onContinue: (metadata: { description: string; name: string }) => void;
  open: boolean;
  seedCount: number;
  sessionName: string;
  title?: string;
}

export function GroupListMetadataDialog({
  continueLabel = "Continue",
  dialogDescription = "Name this reusable static selection before choosing its complete membership.",
  eyebrow = "New static list",
  initialDescription = "",
  initialName = "",
  notice = "Nothing is saved until the membership step is complete.",
  onClose,
  onContinue,
  open,
  seedCount,
  sessionName,
  title = "Create group list",
}: GroupListMetadataDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription);
    setNameError(undefined);
  }, [initialDescription, initialName, open]);

  function continueToMembership() {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setNameError("Name is required.");
      nameRef.current?.focus();
      return;
    }
    onContinue({ description: description.trim(), name: normalizedName });
  }

  return (
    <ModalDialog
      description={dialogDescription}
      eyebrow={eyebrow}
      footer={(
        <>
          <span className="group-list-metadata-footer-note">
            {notice}
          </span>
          <div className="group-list-metadata-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button onClick={continueToMembership} variant="primary">{continueLabel}</Button>
          </div>
        </>
      )}
      initialFocusRef={nameRef}
      onClose={onClose}
      open={open}
      title={title}
    >
      <form
        className="group-list-metadata-form"
        onSubmit={(event) => {
          event.preventDefault();
          continueToMembership();
        }}
      >
        <TextField
          autoComplete="off"
          error={nameError}
          label="Name"
          maxLength={120}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(undefined);
          }}
          placeholder="e.g. Founder education — core"
          ref={nameRef}
          value={name}
        />
        <TextAreaField
          label="Description · Optional"
          maxLength={500}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Explain when this list should be used"
          rows={3}
          value={description}
        />
        <dl className="group-list-metadata-summary">
          <div><dt>Active session</dt><dd>{sessionName}</dd></div>
          <div><dt>Seed selection</dt><dd>{seedCount.toLocaleString()} groups</dd></div>
        </dl>
        <button aria-hidden="true" className="group-list-metadata-submit" tabIndex={-1} type="submit" />
      </form>
    </ModalDialog>
  );
}

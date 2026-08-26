import { useEffect, useState } from "react";

import { TextField } from "@/shared/ui/TextField";
import {
  MAX_PARTICIPANTS,
  type ParticipantFilterErrors,
  validateParticipantRange,
} from "./participant-range";

interface ParticipantRange {
  maxParticipants?: number;
  minParticipants?: number;
}

interface ParticipantRangeFilterProps extends ParticipantRange {
  errors?: ParticipantFilterErrors;
  idPrefix: string;
  onChange: (range: ParticipantRange) => void;
  onErrorsClear?: () => void;
}

export function ParticipantRangeFilter({
  errors = {},
  idPrefix,
  maxParticipants,
  minParticipants,
  onChange,
  onErrorsClear,
}: ParticipantRangeFilterProps) {
  const [minimum, setMinimum] = useState(minParticipants?.toString() ?? "");
  const [maximum, setMaximum] = useState(maxParticipants?.toString() ?? "");
  const [localErrors, setLocalErrors] = useState<ParticipantFilterErrors>({});
  const [rangeDirty, setRangeDirty] = useState(false);

  useEffect(() => {
    setMinimum(minParticipants?.toString() ?? "");
    setMaximum(maxParticipants?.toString() ?? "");
    setRangeDirty(false);
  }, [maxParticipants, minParticipants]);

  function applyParticipantRange() {
    const validation = validateParticipantRange(minimum, maximum);
    setLocalErrors(validation.errors);
    if (validation.errors.minParticipants || validation.errors.maxParticipants) return;
    onErrorsClear?.();
    setRangeDirty(false);
    onChange({
      minParticipants: validation.minParticipants,
      maxParticipants: validation.maxParticipants,
    });
  }

  useEffect(() => {
    if (!rangeDirty) return;
    const timeout = window.setTimeout(applyParticipantRange, 500);
    return () => window.clearTimeout(timeout);
  }, [maximum, minimum, rangeDirty]);

  const minimumError = localErrors.minParticipants ?? errors.minParticipants;
  const maximumError = localErrors.maxParticipants ?? errors.maxParticipants;

  return (
    <form
      className="data-filter-range"
      noValidate
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) applyParticipantRange();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          applyParticipantRange();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        applyParticipantRange();
      }}
    >
      <TextField
        error={minimumError}
        id={`${idPrefix}-min-participants`}
        inputMode="numeric"
        label="Minimum"
        labelHidden
        max={MAX_PARTICIPANTS}
        min={0}
        monospace
        onChange={(event) => {
          setMinimum(event.target.value);
          setRangeDirty(true);
          setLocalErrors((current) => ({ ...current, minParticipants: undefined }));
          onErrorsClear?.();
        }}
        placeholder="Min"
        size="xs"
        step={1}
        type="number"
        value={minimum}
      />
      <span aria-hidden="true" className="data-filter-range-separator">–</span>
      <TextField
        error={maximumError}
        id={`${idPrefix}-max-participants`}
        inputMode="numeric"
        label="Maximum"
        labelHidden
        max={MAX_PARTICIPANTS}
        min={0}
        monospace
        onChange={(event) => {
          setMaximum(event.target.value);
          setRangeDirty(true);
          setLocalErrors((current) => ({ ...current, maxParticipants: undefined }));
          onErrorsClear?.();
        }}
        placeholder="Max"
        size="xs"
        step={1}
        type="number"
        value={maximum}
      />
      <small>Inclusive range · unknown counts excluded.</small>
    </form>
  );
}

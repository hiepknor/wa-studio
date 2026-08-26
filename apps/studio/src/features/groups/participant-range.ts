export const MAX_PARTICIPANTS = 2_147_483_647;

export interface ParticipantFilterErrors {
  maxParticipants?: string;
  minParticipants?: string;
}

function participantValue(value: string, field: "Minimum" | "Maximum"): {
  error?: string;
  value?: number;
} {
  const normalized = value.trim();
  if (!normalized) return {};
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PARTICIPANTS) {
    return {
      error: `${field} must be a whole number from 0 to ${MAX_PARTICIPANTS.toLocaleString()}.`,
    };
  }
  return { value: parsed };
}

export function validateParticipantRange(minimum: string, maximum: string): {
  errors: ParticipantFilterErrors;
  maxParticipants?: number;
  minParticipants?: number;
} {
  const min = participantValue(minimum, "Minimum");
  const max = participantValue(maximum, "Maximum");
  const errors: ParticipantFilterErrors = {
    minParticipants: min.error,
    maxParticipants: max.error,
  };
  if (
    !min.error
    && !max.error
    && min.value !== undefined
    && max.value !== undefined
    && min.value > max.value
  ) {
    errors.minParticipants = "Minimum must not exceed maximum.";
    errors.maxParticipants = "Maximum must be at least the minimum.";
  }
  return {
    errors,
    minParticipants: min.value,
    maxParticipants: max.value,
  };
}

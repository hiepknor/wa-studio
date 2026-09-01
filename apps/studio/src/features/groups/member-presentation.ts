import type { RuntimeGroupMember } from "@/shared/api/runtime-client";

export const UNNAMED_MEMBER_LABEL = "Unnamed member";
export const UNRESOLVED_IDENTITY_LABEL = "Unresolved identity";

export function memberDisplayName(member: RuntimeGroupMember): string {
  return member.displayName?.trim() || UNNAMED_MEMBER_LABEL;
}

export interface MemberIdentityPresentation {
  label: string;
  participantId: string | null;
  resolvedPhoneNumber: string | null;
}

export function memberIdentityPresentation(
  member: RuntimeGroupMember,
): MemberIdentityPresentation {
  const resolvedPhoneNumber = member.resolvedPhoneNumber?.trim() || null;
  const participantId = member.participantId.trim() || null;

  return {
    label:
      resolvedPhoneNumber ?? participantId ?? UNRESOLVED_IDENTITY_LABEL,
    participantId,
    resolvedPhoneNumber,
  };
}

import { describe, expect, it } from "vitest";

import type {
  RuntimeGroupMember,
  RuntimeGroupMemberPage,
} from "@/shared/api/runtime-client";
import {
  memberDisplayName,
  memberIdentityPresentation,
  UNNAMED_MEMBER_LABEL,
  UNRESOLVED_IDENTITY_LABEL,
} from "./member-presentation";

const baseMember: RuntimeGroupMember = {
  participantId: "84900000001@c.us",
  phoneNumber: "84900000001",
  displayName: "Release operator",
  identityType: "PHONE_JID",
  resolvedPhoneNumber: "84900000001",
  displayNameSource: "OPENWA_CONTACT_NAME",
  projectionRevision: 42,
  isAdmin: false,
  isSuperAdmin: false,
};

describe("Contacts v2 member presentation", () => {
  it("is backed by generated enriched member and page metadata types", () => {
    const page: RuntimeGroupMemberPage = {
      data: [baseMember],
      meta: { total: 1, limit: 25, offset: 0, datasetRevision: 42 },
    };

    expect(page.data[0]).toMatchObject({
      identityType: "PHONE_JID",
      resolvedPhoneNumber: "84900000001",
      displayNameSource: "OPENWA_CONTACT_NAME",
      projectionRevision: 42,
    });
    expect(page.meta.datasetRevision).toBe(42);
  });

  it("uses a trimmed display name and never invents one from identity data", () => {
    expect(memberDisplayName({ ...baseMember, displayName: "  Mai  " })).toBe(
      "Mai",
    );
    expect(memberDisplayName({ ...baseMember, displayName: null })).toBe(
      UNNAMED_MEMBER_LABEL,
    );
    expect(memberDisplayName({ ...baseMember, displayName: "   " })).toBe(
      UNNAMED_MEMBER_LABEL,
    );
  });

  it("prefers Runtime-resolved phone and retains the participant identity", () => {
    expect(memberIdentityPresentation(baseMember)).toEqual({
      label: "84900000001",
      participantId: "84900000001@c.us",
      resolvedPhoneNumber: "84900000001",
    });
  });

  it("does not use deprecated phoneNumber or a LID user-part as a phone", () => {
    const lid = {
      ...baseMember,
      participantId: "123456789@lid",
      phoneNumber: "123456789",
      identityType: "LID" as const,
      resolvedPhoneNumber: null,
    };

    expect(memberIdentityPresentation(lid)).toEqual({
      label: "123456789@lid",
      participantId: "123456789@lid",
      resolvedPhoneNumber: null,
    });
  });

  it("falls back to an unresolved state only when participant identity is absent", () => {
    expect(
      memberIdentityPresentation({
        ...baseMember,
        participantId: "   ",
        phoneNumber: "deprecated-value",
        identityType: null,
        resolvedPhoneNumber: null,
      }),
    ).toEqual({
      label: UNRESOLVED_IDENTITY_LABEL,
      participantId: null,
      resolvedPhoneNumber: null,
    });
  });

  it.each([
    "OPENWA_CONTACT_NAME",
    "GROUP_PARTICIPANT_NAME",
    "OPENWA_PUSH_NAME",
    "RESOLVED_ALIAS_PUSH_NAME",
    null,
  ] as const)(
    "renders display-name provenance %s safely",
    (displayNameSource) => {
      const member: RuntimeGroupMember = {
        ...baseMember,
        displayNameSource,
      };

      expect(memberDisplayName(member)).toBe("Release operator");
      expect(memberIdentityPresentation(member).label).toBe("84900000001");
    },
  );
});

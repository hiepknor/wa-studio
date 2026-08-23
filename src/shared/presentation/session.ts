import type { RuntimeSession } from "@/shared/api/runtime-client";

type SessionIdentity = Pick<RuntimeSession, "id" | "phone" | "pushName">;

export function sessionIdentityLabel(session: SessionIdentity): string {
  const parts = [session.pushName?.trim(), session.phone?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? [...new Set(parts)].join(" · ") : session.id;
}

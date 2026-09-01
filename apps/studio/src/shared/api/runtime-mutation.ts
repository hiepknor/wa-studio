import { RuntimeTransportError } from "./runtime-http";

export type UnknownMutationRecovery =
  | "canonical-reload"
  | "idempotent-retry"
  | "observe-background";

export function isUnknownMutationOutcome(error: unknown): boolean {
  return error instanceof RuntimeTransportError && error.requestDispatched;
}

export function unknownMutationOutcomeMessage(
  recovery: UnknownMutationRecovery,
): string {
  if (recovery === "idempotent-retry") {
    return "WA Runtime did not confirm the result. Retry uses the same request key and cannot create a duplicate.";
  }
  if (recovery === "observe-background") {
    return "WA Runtime did not confirm the request. It may still be running; review the latest Runtime state before requesting it again.";
  }
  return "WA Runtime did not confirm the result. Its authoritative state is being reloaded; review it before retrying.";
}

import { RuntimeRequestError } from "@/shared/api/runtime-client";

const GROUP_LIST_ERROR_COPY: Record<string, string> = {
  GROUP_LIST_ARCHIVED: "This group list is archived and can no longer be changed.",
  GROUP_LIST_GROUP_DUPLICATE: "Each group can appear only once in a group list.",
  GROUP_LIST_GROUP_INVALID: "One or more group IDs are invalid.",
  GROUP_LIST_GROUP_LIMIT_EXCEEDED: "A group list can contain at most 1,000 unique groups.",
  GROUP_LIST_GROUP_NOT_FOUND: "One or more selected groups no longer exist.",
  GROUP_LIST_GROUP_SESSION_MISMATCH: "Every selected group must belong to the group list session.",
  GROUP_LIST_IDEMPOTENCY_CONFLICT: "This create key was already used with different list details. Start a new list intent.",
  GROUP_LIST_IDEMPOTENCY_KEY_INVALID: "Runtime rejected the group list create key.",
  GROUP_LIST_IDEMPOTENCY_KEY_REQUIRED: "A create key is required for a new group list.",
  GROUP_LIST_NAME_CONFLICT: "A group list with this name already exists in the active session.",
  GROUP_LIST_NAME_INVALID: "Enter a valid group list name.",
  GROUP_LIST_NOT_FOUND: "This group list no longer exists or is outside the active session.",
  GROUP_LIST_QUERY_INVALID: "Review the group list search query.",
  GROUP_LIST_REVISION_CONFLICT: "This group list changed in Runtime. Its canonical state was reloaded; review your staged changes before saving again.",
  GROUP_LIST_SESSION_INVALID: "The selected Runtime session is invalid.",
  GROUP_LIST_SESSION_NOT_FOUND: "The selected Runtime session no longer exists or is outside your scope.",
};

export function groupListErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeRequestError) {
    if (error.code && GROUP_LIST_ERROR_COPY[error.code]) {
      return GROUP_LIST_ERROR_COPY[error.code];
    }
    if (error.status === 401) {
      return "Runtime rejected this request. Reconnect with a valid Runtime key.";
    }
    if (error.status === 404) {
      return "The requested group list resource is no longer available.";
    }
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

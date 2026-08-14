export interface MemberDatasetDecision {
  action: "accept" | "restart";
  revision: number;
}

export function reconcileMemberDatasetRevision(
  currentRevision: number | null,
  responseRevision: number,
  restartAvailable: boolean,
): MemberDatasetDecision {
  if (currentRevision === null || currentRevision === responseRevision) {
    return { action: "accept", revision: responseRevision };
  }

  return {
    action: restartAvailable ? "restart" : "accept",
    revision: responseRevision,
  };
}

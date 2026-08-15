export const MAX_GROUP_SELECTION = 1_000;

export type SelectionApplyMode = "add" | "replace";

export interface SelectionApplyResult {
  addedCount: number;
  nextIds: string[];
  ok: boolean;
}

export interface GroupSelectionDiff {
  addedIds: string[];
  removedIds: string[];
  savedCount: number;
  stagedCount: number;
}

export function groupSelectionDiff(
  savedIds: readonly string[],
  stagedIds: readonly string[],
): GroupSelectionDiff {
  const saved = new Set(savedIds);
  const staged = new Set(stagedIds);
  return {
    addedIds: [...staged].filter((id) => !saved.has(id)),
    removedIds: [...saved].filter((id) => !staged.has(id)),
    savedCount: saved.size,
    stagedCount: staged.size,
  };
}

export function applyGroupSelectionSnapshot(
  currentIds: readonly string[],
  snapshotIds: readonly string[],
  mode: SelectionApplyMode,
  limit = MAX_GROUP_SELECTION,
): SelectionApplyResult {
  const current = [...new Set(currentIds)];
  const snapshot = [...new Set(snapshotIds)];
  const currentSet = new Set(current);
  const nextIds = mode === "replace"
    ? snapshot
    : [...current, ...snapshot.filter((id) => !currentSet.has(id))];
  if (nextIds.length > limit) return { addedCount: 0, nextIds: current, ok: false };
  return {
    addedCount: nextIds.filter((id) => !currentSet.has(id)).length,
    nextIds,
    ok: true,
  };
}

export function sameGroupSelection(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((id) => expected.has(id));
}

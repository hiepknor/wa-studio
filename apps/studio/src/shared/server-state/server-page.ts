interface ReconciledPageOffsetInput {
  limit: number;
  offset: number;
  rowCount: number;
  total: number;
}

export function lastPageOffset(total: number, limit: number): number {
  if (total <= 0) return 0;
  return Math.floor((total - 1) / limit) * limit;
}

/**
 * Returns the canonical offset when a mutation or background reconciliation
 * removes the last row from the currently requested page.
 */
export function reconciledPageOffset({
  limit,
  offset,
  rowCount,
  total,
}: ReconciledPageOffsetInput): number | null {
  if (offset <= 0 || rowCount > 0 || total > offset) return null;
  return lastPageOffset(total, limit);
}

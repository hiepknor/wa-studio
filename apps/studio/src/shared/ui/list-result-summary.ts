interface ListResultSummaryOptions {
  firstItem: number;
  hasCriteria: boolean;
  lastItem: number;
  plural: string;
  singular: string;
  total: number;
}

export function formatListResultSummary({
  firstItem,
  hasCriteria,
  lastItem,
  plural,
  singular,
  total,
}: ListResultSummaryOptions): string {
  if (total === 0) return hasCriteria ? "0 matches" : `0 ${plural}`;

  const noun = total === 1 ? singular : plural;
  if (firstItem === 1 && lastItem === total) {
    return hasCriteria
      ? `${total} ${total === 1 ? "match" : "matches"}`
      : `${total} ${noun}`;
  }

  return `${firstItem}–${lastItem} of ${total}${hasCriteria ? " matches" : ""}`;
}

export function formatLoadedResultSummary(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural} loaded`;
}

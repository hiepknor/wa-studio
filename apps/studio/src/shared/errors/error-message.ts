export function userFacingErrorMessage(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): string {
  const candidate = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  let message = candidate.trim().length > 0 ? candidate : fallback;
  const submittedSecrets = [...new Set(secrets)]
    .filter(secret => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of submittedSecrets) {
    message = message.split(secret).join("[redacted]");
  }
  return message;
}

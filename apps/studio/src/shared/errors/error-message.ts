export function userFacingErrorMessage(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): string {
  let message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
  const submittedSecrets = [...new Set(secrets)]
    .filter(secret => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of submittedSecrets) {
    message = message.split(secret).join("[redacted]");
  }
  return message;
}

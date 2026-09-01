export type FeedbackTone = "neutral" | "info" | "success" | "warning" | "danger";

export function feedbackRole(tone: FeedbackTone): "alert" | "status" {
  return tone === "danger" ? "alert" : "status";
}

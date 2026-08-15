export type FieldSize = "xs" | "sm" | "md";

export const DEFAULT_FIELD_SIZE: FieldSize = "sm";

export function fieldSizeClassName(size: FieldSize): string {
  return `ui-field ui-field-${size}`;
}

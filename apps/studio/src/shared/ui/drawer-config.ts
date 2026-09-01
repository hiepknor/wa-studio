export type DrawerSize = "compact" | "standard" | "wide";
export type DrawerMode = "docked" | "overlay";

export interface DrawerSizeConfig {
  maxWidth: number;
  minWidth: number;
  preferredRatio: number;
}

export interface DrawerLayout {
  mode: DrawerMode;
  width: number;
}

export const DRAWER_MAIN_MIN_WIDTH = 760;

export const DRAWER_SIZE_CONFIG: Record<DrawerSize, DrawerSizeConfig> = {
  compact: { minWidth: 360, maxWidth: 440, preferredRatio: 0.26 },
  standard: { minWidth: 400, maxWidth: 560, preferredRatio: 0.3 },
  wide: { minWidth: 480, maxWidth: 720, preferredRatio: 0.36 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveDrawerLayout({
  frameWidth,
  railWidth,
  size,
}: {
  frameWidth: number;
  railWidth: number;
  size: DrawerSize;
}): DrawerLayout {
  const config = DRAWER_SIZE_CONFIG[size];
  const preferredWidth = clamp(
    Math.round(frameWidth * config.preferredRatio),
    config.minWidth,
    config.maxWidth,
  );
  const maximumDockedWidth = Math.floor(
    frameWidth - railWidth - DRAWER_MAIN_MIN_WIDTH,
  );

  if (maximumDockedWidth < config.minWidth) {
    return { mode: "overlay", width: preferredWidth };
  }

  return {
    mode: "docked",
    width: Math.min(preferredWidth, maximumDockedWidth),
  };
}

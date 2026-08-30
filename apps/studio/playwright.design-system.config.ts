import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:1422";

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.003,
    },
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
      },
    },
  ],
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  retries: process.env.CI ? 1 : 0,
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  testDir: "./tests/design-system",
  testMatch: /.*\.pw\.ts/,
  timeout: 30_000,
  use: {
    baseURL,
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run design-system:serve",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: `${baseURL}/design-system.html`,
  },
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const galleryPath = "/design-system.html";
const productFixturePath = "/product-fixtures.html";
const referenceTime = new Date("2026-08-30T17:30:00.000Z");

async function openGallery(page: Page, width = 1500, height = 850) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.setFixedTime(referenceTime);
  await page.setViewportSize({ width, height });
  await page.goto(galleryPath);
  await page.evaluate(() => document.fonts.ready);
}

async function openProductFixture(
  page: Page,
  view: "campaigns" | "connection" | "groups",
  width: number,
  height: number,
) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.setFixedTime(referenceTime);
  await page.setViewportSize({ width, height });
  await page.goto(`${productFixturePath}?view=${view}`);
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, results.violations.map((violation) => (
    `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => node.target.join(" ")).join("\n")}`
  )).join("\n\n")).toEqual([]);
}

test("@a11y gallery and production overlay states have no axe violations", async ({ page }) => {
  await openGallery(page);
  await expectNoAccessibilityViolations(page);

  await page.getByRole("button", { name: "Actions" }).click();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open modal" }).click();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open confirmation" }).click();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open workspace" }).click();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open drawer" }).click();
  await expectNoAccessibilityViolations(page);
  await page.getByRole("button", { name: "Close drawer" }).click();

  await page.getByRole("button", { name: "Show toast" }).click();
  await expect(page.getByText("Capability updated").last()).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("@a11y representative product screens have no axe violations", async ({ page }) => {
  await openProductFixture(page, "connection", 1100, 720);
  await expect(page.getByRole("heading", { name: "Attach an external Runtime" })).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await openProductFixture(page, "groups", 1100, 720);
  await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  await expect(page.getByText("North America operations").last()).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await openProductFixture(page, "campaigns", 1100, 720);
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "August product release" }).click();
  await expect(page.getByRole("heading", { name: "Content & schedule" })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("@a11y reduced motion collapses transition and animation duration", async ({ page }) => {
  await openGallery(page);
  const timing = await page.getByRole("button", { name: "Primary action" }).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(["0s", "1e-05s"]).toContain(timing.animationDuration);
  expect(timing.transitionDuration).toBe("1e-05s");
});

for (const viewport of [
  { height: 560, name: "compact", width: 960 },
  { height: 720, name: "desktop", width: 1100 },
  { height: 850, name: "wide", width: 1500 },
] as const) {
  test(`@visual gallery ${viewport.name} baseline`, async ({ page }) => {
    await openGallery(page, viewport.width, viewport.height);
    await expect(page.locator(".ds-gallery")).toHaveScreenshot(
      `gallery-${viewport.width}x${viewport.height}.png`,
      { fullPage: true },
    );
  });
}

for (const viewport of [
  { height: 560, name: "compact", width: 960 },
  { height: 720, name: "desktop", width: 1100 },
  { height: 850, name: "wide", width: 1500 },
] as const) {
  test(`@visual product connection ${viewport.name}`, async ({ page }) => {
    await openProductFixture(page, "connection", viewport.width, viewport.height);
    await expect(page.getByRole("heading", { name: "Attach an external Runtime" })).toBeVisible();
    await expect(page.locator(".connection-shell")).toHaveScreenshot(
      `product-connection-${viewport.width}x${viewport.height}.png`,
    );
  });

  test(`@visual product Groups ${viewport.name}`, async ({ page }) => {
    await openProductFixture(page, "groups", viewport.width, viewport.height);
    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
    await expect(page.getByText("North America operations").last()).toBeVisible();
    await expect(page.locator(".workspace")).toHaveScreenshot(
      `product-groups-${viewport.width}x${viewport.height}.png`,
    );
  });

  test(`@visual product Campaign Workspace ${viewport.name}`, async ({ page }) => {
    await openProductFixture(page, "campaigns", viewport.width, viewport.height);
    await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
    await page.getByRole("button", { exact: true, name: "August product release" }).click();
    await expect(page.getByRole("heading", { name: "Content & schedule" })).toBeVisible();
    await expect(page.locator(".modal-dialog-backdrop")).toHaveScreenshot(
      `product-campaign-workspace-${viewport.width}x${viewport.height}.png`,
    );
  });
}

test("@visual keyboard focus treatment", async ({ page }) => {
  await openGallery(page, 1100, 720);
  const field = page.getByRole("textbox", { name: "Campaign name" });
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  for (let index = 0; index < 60; index += 1) {
    await page.keyboard.press("Tab");
    if (await field.evaluate((element) => document.activeElement === element)) break;
  }
  await expect(field).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-focus-modality", "keyboard");
  await expect(page.locator("#fields")).toHaveScreenshot("keyboard-focus.png");
});

test("@visual modal hierarchy", async ({ page }) => {
  await openGallery(page, 1100, 720);
  await page.getByRole("button", { name: "Open modal" }).click();
  await expect(page.locator(".modal-dialog-backdrop")).toHaveScreenshot("modal.png");
});

test("@visual menu hierarchy", async ({ page }) => {
  await openGallery(page, 1100, 720);
  await page.getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("menu")).toHaveScreenshot("menu.png");
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const galleryPath = "/design-system.html";

async function openGallery(page: Page, width = 1500, height = 850) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await page.goto(galleryPath);
  await page.evaluate(() => document.fonts.ready);
}

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, results.violations.map((violation) => (
    `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => node.target.join(" ")).join("\n")}`
  )).join("\n\n")).toEqual([]);
}

test("@a11y gallery and closed overlay states have no axe violations", async ({ page }) => {
  await openGallery(page);
  await expectNoAccessibilityViolations(page);

  await page.getByRole("button", { name: "Actions" }).click();
  await expectNoAccessibilityViolations(page);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open modal" }).click();
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

test("@visual keyboard focus treatment", async ({ page }) => {
  await openGallery(page, 1100, 720);
  const field = page.getByRole("textbox", { name: "Campaign name" });
  await field.focus();
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

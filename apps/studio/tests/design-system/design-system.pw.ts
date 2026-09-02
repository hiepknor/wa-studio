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
  view: "activity" | "campaigns" | "connection" | "groups" | "runs",
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

test("@a11y business inspectors have no axe violations in responsive modes", async ({ page }) => {
  await openProductFixture(page, "activity", 1100, 720);
  await page.getByRole("button", { exact: true, name: "Campaign run completed" }).click();
  await expect(page.getByRole("dialog", { name: "Campaign run completed" })).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await openProductFixture(page, "groups", 1440, 850);
  await page.getByRole("button", { name: "View North America operations" }).click();
  const groupInspector = page.getByRole("complementary", { name: "North America operations" });
  await expect(groupInspector.getByRole("heading", { name: "Group details" })).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await groupInspector.getByRole("tab", { name: "Members" }).click();
  await expect(groupInspector.getByRole("table", { name: "Synchronized members" })).toBeVisible();
  await expectNoAccessibilityViolations(page);

  await openProductFixture(page, "runs", 1920, 1080);
  await page.getByRole("button", { name: "August product release" }).click();
  const runInspector = page.getByRole("complementary", { name: "August product release" });
  await expect(runInspector.getByRole("heading", { name: "Run summary" })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test("minimum-window inspector keeps navigation outside content scrolling", async ({ page }) => {
  await openProductFixture(page, "groups", 960, 560);
  await page.getByRole("button", { name: /North America operations/ }).last().click();

  const inspector = page.getByRole("dialog", { name: "North America operations" });
  const body = inspector.locator(".drawer-body");
  const subheader = inspector.locator(".drawer-subheader");
  await expect(inspector.getByRole("heading", { name: "Group details" })).toBeVisible();
  await expect(subheader.getByRole("tablist")).toBeVisible();
  expect(await body.getByRole("tablist").count()).toBe(0);

  const inspectorBox = await inspector.boundingBox();
  const subheaderBox = await subheader.boundingBox();
  const bodyBox = await body.boundingBox();
  expect(inspectorBox?.width).toBe(400);
  expect((subheaderBox?.y ?? 0) + (subheaderBox?.height ?? 0))
    .toBeLessThanOrEqual(bodyBox?.y ?? 0);

  await inspector.getByRole("tab", { name: "Members" }).click();
  await expect(inspector.getByRole("table", { name: "Synchronized members" })).toBeVisible();
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await inspector.getByRole("tab", { name: "Overview" }).click();
  await expect(inspector.getByRole("heading", { name: "Group details" })).toBeVisible();
  expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  await expectNoAccessibilityViolations(page);
});

test("minimum-window Run inspector keeps metric rows balanced", async ({ page }) => {
  await openProductFixture(page, "runs", 960, 560);
  await page.getByRole("button", { name: "August product release" }).click();

  const inspector = page.getByRole("dialog", { name: "August product release" });
  const metrics = inspector.getByRole("group", { name: "Key run progress" }).locator("dl");
  await expect(metrics).toHaveCount(4);
  await expect(inspector.getByText("Remaining", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Successful", { exact: true })).toBeVisible();

  const boxes = await metrics.evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width };
  }));
  expect(boxes[0]?.x).toBe(boxes[2]?.x);
  expect(boxes[1]?.x).toBe(boxes[3]?.x);
  expect(boxes[2]?.y).toBeGreaterThan(boxes[0]?.y ?? 0);
  expect(boxes[0]?.width).toBe(boxes[1]?.width);
  const lifecycle = inspector.locator("details.runs-detail-disclosure").filter({
    hasText: "Lifecycle",
  });
  await expect(lifecycle).not.toHaveAttribute("open", "");
  await lifecycle.locator("summary").click();
  const lifecycleRow = inspector.getByRole("group", { name: "Run lifecycle" }).locator("dl").first();
  const [lifecycleLabel, lifecycleValue] = await Promise.all([
    lifecycleRow.locator("dt").boundingBox(),
    lifecycleRow.locator("dd").boundingBox(),
  ]);
  expect(lifecycleLabel?.y).toBe(lifecycleValue?.y);
  expect(await lifecycleRow.locator("dd").evaluate(
    (element) => getComputedStyle(element).textAlign,
  )).toBe("end");
  const launchDetails = inspector.locator("details.runs-detail-disclosure").filter({
    hasText: "Immutable launch",
  });
  await launchDetails.locator("summary").click();
  const runIdValue = inspector.getByRole("group", {
    name: "Immutable launch snapshot",
  }).locator("dd").first();
  await expect(runIdValue.locator("span")).toHaveAttribute(
    "title",
    "22222222-2222-4222-8222-222222222222",
  );
  expect(await runIdValue.evaluate((element) => (
    element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) * 1.5
  ))).toBe(true);
  const progressDetails = inspector.locator("details.runs-progress-disclosure");
  await progressDetails.locator("summary").click();
  const progressBorders = await inspector.getByRole("group", {
    name: "Run delivery progress",
  }).locator("dl").evaluateAll((items) => items.slice(0, 4).map((item) => ({
    left: getComputedStyle(item).borderLeftWidth,
    top: getComputedStyle(item).borderTopWidth,
  })));
  expect(progressBorders).toEqual([
    { left: "0px", top: "0px" },
    { left: "1px", top: "0px" },
    { left: "0px", top: "1px" },
    { left: "1px", top: "1px" },
  ]);
  expect(await inspector.locator(".drawer-footer").evaluate(
    (footer) => footer.getBoundingClientRect().height,
  )).toBeLessThanOrEqual(64);
  expect(await inspector.locator(".drawer-body").evaluate(
    (body) => body.scrollWidth - body.clientWidth,
  )).toBeLessThanOrEqual(0);

  await inspector.getByRole("tab", { name: "Deliveries" }).click();
  const deliveryTable = inspector.getByRole("table", {
    name: "Per-group deliveries for this run",
  });
  await expect(deliveryTable).toBeVisible();
  await expect(deliveryTable.getByRole("columnheader")).toHaveCount(3);
  const deliveryColumnWidths = await deliveryTable.getByRole("columnheader")
    .evaluateAll((headers) => headers.map((header) => header.getBoundingClientRect().width));
  expect(deliveryColumnWidths[0]).toBeGreaterThanOrEqual(96);
  expect(deliveryColumnWidths[1]).toBeGreaterThanOrEqual(200);
  expect(deliveryColumnWidths[2]).toBeGreaterThanOrEqual(96);
  await expect(deliveryTable.getByText("Blocked Capability Changed")).toBeVisible();
  expect(await deliveryTable.locator("tbody td.data-cell-status").first().evaluate(
    (cell) => cell.scrollWidth - cell.clientWidth,
  )).toBeLessThanOrEqual(0);
  expect(await deliveryTable.locator("tbody td.data-cell-time").first().evaluate(
    (cell) => cell.scrollWidth - cell.clientWidth,
  )).toBeLessThanOrEqual(0);
  const deliveryToolbar = inspector.locator(".run-deliveries-toolbar");
  const [deliverySearch, deliveryStatus] = await Promise.all([
    deliveryToolbar.getByRole("searchbox", { name: "Search deliveries" }).boundingBox(),
    deliveryToolbar.getByRole("combobox", { name: "Delivery status" }).boundingBox(),
  ]);
  expect(deliverySearch?.y).toBe(deliveryStatus?.y);
  expect((deliverySearch?.x ?? 0) + (deliverySearch?.width ?? 0))
    .toBeLessThanOrEqual(deliveryStatus?.x ?? 0);
  expect(await inspector.locator(".drawer-body").evaluate(
    (body) => body.scrollWidth - body.clientWidth,
  )).toBeLessThanOrEqual(0);
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

test("@visual Activity inspector overlays at 1100px", async ({ page }) => {
  await openProductFixture(page, "activity", 1100, 720);
  await page.getByRole("button", { exact: true, name: "Campaign run completed" }).click();
  await expect(page.getByRole("dialog", { name: "Campaign run completed" })).toBeVisible();
  await expect(page.locator(".workspace")).toHaveScreenshot(
    "product-activity-inspector-1100x720.png",
  );
});

test("Activity inspector preserves compact audit density across responsive modes", async ({ page }) => {
  for (const viewport of [
    { height: 560, mode: "overlay", role: "dialog" as const, width: 960 },
    { height: 1080, mode: "docked", role: "complementary" as const, width: 1920 },
  ]) {
    await openProductFixture(page, "activity", viewport.width, viewport.height);
    await page.getByRole("button", { exact: true, name: "Campaign run completed" }).click();
    const inspector = page.getByRole(viewport.role, { name: "Campaign run completed" });
    await expect(inspector).toBeVisible();
    await expect(page.locator(".drawer-frame")).toHaveAttribute("data-drawer-mode", viewport.mode);

    const body = inspector.locator(".drawer-body");
    const horizontalOverflow = await body.evaluate((element) => (
      element.scrollWidth - element.clientWidth
    ));
    expect(horizontalOverflow).toBeLessThanOrEqual(0);

    const subject = inspector.getByRole("group", { name: "Event subject" });
    const subjectLabelBox = await subject.locator("dt").boundingBox();
    const subjectValue = subject.locator(".activity-detail-value");
    const subjectValueBox = await subjectValue.boundingBox();
    expect(Math.abs((subjectLabelBox?.y ?? 0) - (subjectValueBox?.y ?? 0))).toBeLessThan(4);
    await expect(subjectValue).toHaveAttribute("title", /22222222-/);
    expect(await subjectValue.evaluate((element) => getComputedStyle(element).whiteSpace))
      .toBe("nowrap");

    await inspector.getByText("Allowlisted metadata").click();
    const metadataValues = inspector.getByRole("group", { name: "Allowlisted metadata" })
      .locator(".activity-detail-value");
    await expect(metadataValues).toHaveCount(3);
    await expect(metadataValues.nth(1)).toHaveAttribute("title", /openwa-safety-v4/);
  }
});

test("@visual Group inspector docks at 1440px", async ({ page }) => {
  await openProductFixture(page, "groups", 1440, 850);
  await page.getByRole("button", { name: "View North America operations" }).click();
  const inspector = page.getByRole("complementary", { name: "North America operations" });
  await expect(inspector.getByRole("heading", { name: "Group details" })).toBeVisible();
  const groupToolbar = page.locator(".data-filter-toolbar").first();
  const filterBox = await groupToolbar.getByRole("button", { exact: true, name: "Filters" }).boundingBox();
  const resultBox = await groupToolbar.locator(".data-filter-result-summary").boundingBox();
  expect(filterBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  expect((filterBox?.x ?? 0) + (filterBox?.width ?? 0)).toBeLessThanOrEqual(resultBox?.x ?? 0);
  await expect(page.locator(".workspace")).toHaveScreenshot(
    "product-group-inspector-1440x850.png",
  );
  await inspector.getByRole("tab", { name: "Members" }).click();
  await expect(inspector.getByText("Mai Nguyen")).toBeVisible();
  const horizontalOverflow = await inspector.locator(".drawer-body").evaluate(
    (body) => body.scrollWidth - body.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(0);
  await expect(page.locator(".workspace")).toHaveScreenshot(
    "product-group-members-inspector-1440x850.png",
  );
});

test("@visual Run inspector expands at 1920px", async ({ page }) => {
  await openProductFixture(page, "runs", 1920, 1080);
  await page.getByRole("button", { name: "August product release" }).click();
  const inspector = page.getByRole("complementary", { name: "August product release" });
  await expect(inspector.getByRole("heading", { name: "Run summary" })).toBeVisible();
  await expect(page.locator(".workspace")).toHaveScreenshot(
    "product-run-inspector-1920x1080.png",
  );
});

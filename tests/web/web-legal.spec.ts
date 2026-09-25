import { expect, test } from "@playwright/test";

const legalPages = [
  ["Terms of Service", "/terms"],
  ["Privacy Policy", "/privacy"],
  ["Refund Policy", "/refunds"],
  ["Contact", "/contact"]
];
const email = "cowiejulewbfwo@gmail.com";

test("public legal pages and contact are reachable from the homepage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("HK$10")).toBeVisible();
  for (const [name, path] of legalPages) {
    await page.getByRole("navigation", { name: "Legal and contact" }).getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator("footer").getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
    await page.getByRole("link", { name: "Notes", exact: true }).first().click();
  }
});

test("legal pages support anonymous direct visits and refresh on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const [name, path] of legalPages) {
    await page.goto(path);
    await page.reload();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await expect(page.locator("address").getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
});

test("account pages expose policies and registration preserves entered data when reading them", async ({ page }) => {
  for (const path of ["/login", "/register"]) {
    await page.goto(path);
    for (const [name, href] of legalPages) {
      await expect(page.getByRole("navigation", { name: "Legal and contact" }).getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
    }
  }
  await page.getByRole("textbox", { name: "Username", exact: true }).fill("policy-reader");
  const popupPromise = page.waitForEvent("popup");
  await page.locator(".policy-notice").getByRole("link", { name: "Terms of Service" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Terms of Service", exact: true })).toBeVisible();
  await popup.close();
  await expect(page.getByRole("textbox", { name: "Username", exact: true })).toHaveValue("policy-reader");
});

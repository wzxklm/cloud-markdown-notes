import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("anonymous homepage guides support navigation, direct links and the complete skill download", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("link", { name: "Guides", exact: true }).click();
  await page.getByRole("link", { name: "Use the Notes CLI with AI" }).click();
  await expect(page).toHaveURL(/#cli-guide$/);
  const raw = page.getByRole("link", { name: "the complete SKILL.md" });
  await expect(raw).toBeVisible();
  const response = await page.request.get("/guides/SKILL.md");
  expect(await response.text()).toBe(readFileSync("docs/skills/cloud-notes-cli/SKILL.md", "utf8"));
  await page.goto("/#mcp-guide");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Create a key" })).toBeVisible();
  await expect(page.getByText("https://notes.bosschat.de/mcp", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { expect, test } from "@playwright/test";
import { createActiveUser, loginViaUi } from "./helpers";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("creates and revokes a personal MCP key", async ({ page, request }) => {
  const account = await createActiveUser(request, "web-key");
  await loginViaUi(page, account.username, account.password);
  await page.getByRole("button", { name: "MCP keys" }).click();
  await page.getByLabel("Key name").fill("Laptop");
  await page.getByRole("button", { name: "Create MCP key" }).click();
  const secret = page.getByLabel("New MCP key");
  await expect(secret).toBeVisible();
  expect((await secret.inputValue()).startsWith("notes_mcp.")).toBe(true);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy key" }).click();
  await expect(page.getByText("Key copied.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied === await secret.inputValue()).toBe(true);
  const link = page.getByLabel("ChatGPT connection URL");
  const url = new URL(await link.inputValue());
  expect(url.origin === new URL(page.url()).origin && url.pathname === "/mcp" && url.searchParams.has("link")).toBe(true);
  await page.getByRole("button", { name: "Copy ChatGPT link" }).click();
  await expect(page.getByText("ChatGPT link copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText()) === url.href).toBe(true);
  await page.goto("/app");
  await page.getByRole("button", { name: "MCP keys" }).click();
  await expect(secret).toHaveCount(0);
  await expect(link).toHaveCount(0);
  const revoke = page.getByRole("button", { name: "Revoke Laptop" });
  page.once("dialog", dialog => dialog.accept());
  await revoke.click();
  await expect(revoke).toHaveCount(0);
});

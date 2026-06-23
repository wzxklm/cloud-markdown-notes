import { expect, test } from "@playwright/test";
import { adminPassword, adminUsername, uniqueName } from "./helpers";

test("registers a pending user, activates it as admin, and logs in", async ({ page }) => {
  const username = uniqueName("web-auth");
  const password = `${username}-password`;

  await page.goto("/");
  await page.locator(".segmented").getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Register" }).last().click();
  await expect(
    page.getByText(`${username} is waiting for administrator activation.`)
  ).toBeVisible();

  await page.locator(".segmented").getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(`${password}-wrong`);
  await page.getByRole("button", { name: "Login" }).last().click();
  await expect(page.getByText("Invalid username or password.")).toBeVisible();

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).last().click();
  await expect(
    page.getByText("Your account is waiting for administrator activation.")
  ).toBeVisible();

  await page.getByLabel("Username").fill(adminUsername);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Login" }).last().click();
  await expect(page.getByText(`${adminUsername} · admin`)).toBeVisible();

  await page.locator(".tabs").getByRole("button", { name: "admin" }).click();
  await expect(page.getByText(username)).toBeVisible();
  await page.getByRole("button", { name: "Reload pending users" }).click();
  await expect(page.getByText(username)).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: username })
    .getByRole("button", { name: "Activate" })
    .click();
  await expect(page.getByText("User activated")).toBeVisible();

  await page.getByRole("button", { name: "Logout" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).last().click();
  await expect(page.getByText(`${username} · user`)).toBeVisible();
  await expect(page.getByText("No note selected")).toBeVisible();
});

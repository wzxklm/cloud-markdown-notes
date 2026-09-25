import { expect, test } from "@playwright/test";

test("billing displays scheduled cancellation, resumption and ended subscriptions", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("cloud-markdown-notes-token", "billing-fixture"));
  const data = {
    user: { username: "billing-reader", email: "reader@example.com" },
    status: "active", active: true, manualAccess: false, enabled: true, hasCustomer: true,
    currentPeriodEnd: "2026-10-25T18:44:53.000Z",
    cancelAtPeriodEnd: false, cancelAt: "2026-10-25T18:44:53.000Z" as string | null,
    canceledAt: "2026-09-25T18:50:46.000Z" as string | null
  };
  await page.route("**/api/billing/status", route => route.fulfill({ json: { data } }));
  await page.goto("/billing");
  await expect(page.getByText("Cancellation scheduled · no further renewal", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancellation effective on")).toBeVisible();
  await expect(page.getByText("Paid access until")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await expect(page.getByText("HKD 10 / month · automatically renews until cancelled", { exact: true })).toHaveCount(0);

  data.cancelAt = null;
  data.cancelAtPeriodEnd = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Cancellation scheduled · no further renewal", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancellation effective on")).toHaveCount(0);

  data.cancelAtPeriodEnd = false;
  data.canceledAt = null;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("HKD 10 / month · automatically renews until cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancellation scheduled · no further renewal", { exact: true })).toHaveCount(0);

  data.status = "canceled";
  data.active = false;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByText("Subscription cancelled · no further renewal", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending activation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Subscribe · HKD 10/month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace" })).toHaveCount(0);
});

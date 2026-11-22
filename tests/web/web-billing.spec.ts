import { expect, test } from "@playwright/test";

test("billing displays scheduled cancellation, resumption and ended subscriptions", async ({
  page
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("cloud-markdown-notes-token", "billing-fixture")
  );
  const data = {
    wallet: { balance: 0, currency: "hkd", autoRenew: false, periodEnd: null, enabled: true },
    cardPeriodEnd: "2026-10-25T18:44:53.000Z",
    user: { username: "billing-reader", email: "reader@example.com" },
    status: "active",
    active: true,
    manualAccess: false,
    enabled: true,
    hasCustomer: true,
    currentPeriodEnd: "2026-10-25T18:44:53.000Z",
    cancelAtPeriodEnd: false,
    cancelAt: "2026-10-25T18:44:53.000Z" as string | null,
    canceledAt: "2026-09-25T18:50:46.000Z" as string | null
  };
  await page.route("**/api/billing/status", (route) => route.fulfill({ json: { data } }));
  await page.route("**/api/billing/wallet/transactions", (route) =>
    route.fulfill({ json: { data: { transactions: [], nextCursor: null } } })
  );
  await page.goto("/billing");
  await expect(
    page.getByText("Cancellation scheduled · no further renewal", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Cancellation effective on")).toBeVisible();
  await expect(page.getByText("Paid access until")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await expect(
    page.getByText("Card subscription · HKD 10/month · automatically renews until cancelled", {
      exact: true
    })
  ).toHaveCount(0);

  data.cancelAt = null;
  data.cancelAtPeriodEnd = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(
    page.getByText("Cancellation scheduled · no further renewal", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Cancellation effective on")).toHaveCount(0);

  data.cancelAtPeriodEnd = false;
  data.canceledAt = null;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(
    page.getByText("Card subscription · HKD 10/month · automatically renews until cancelled", {
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByText("Cancellation scheduled · no further renewal", { exact: true })
  ).toHaveCount(0);

  data.status = "canceled";
  data.active = false;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(
    page.getByText("Subscription cancelled · no further renewal", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Pending activation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Subscribe · HKD 10/month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace" })).toHaveCount(0);
  data.manualAccess = true;
  data.active = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Subscribe · HKD 10/month" })).toHaveCount(0);
});

test("balance top-up, subscription controls and transaction history", async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("cloud-markdown-notes-token", "wallet-fixture")
  );
  const data = {
    user: { username: "wallet-reader", email: "wallet@example.test" },
    status: null,
    active: false,
    manualAccess: false,
    enabled: true,
    hasCustomer: true,
    currentPeriodEnd: null as string | null,
    cardPeriodEnd: null,
    cancelAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    wallet: {
      balance: 3000,
      currency: "hkd",
      autoRenew: false,
      periodEnd: null as string | null,
      enabled: true
    }
  };
  await page.route("**/api/billing/status", (r) => r.fulfill({ json: { data } }));
  await page.route("**/api/billing/wallet/transactions", (r) =>
    r.fulfill({
      json: {
        data: {
          transactions: [
            {
              id: "1",
              amount: 3000,
              balanceAfter: 3000,
              kind: "topup",
              createdAt: "2026-10-08T00:00:00Z"
            }
          ],
          nextCursor: null
        }
      }
    })
  );
  await page.route("**/api/billing/wallet/subscription", async (r) => {
    if (r.request().method() === "POST") {
      data.wallet.autoRenew = true;
      data.wallet.balance = 2000;
      data.active = true;
      data.currentPeriodEnd = "2099-11-08T00:00:00Z";
      data.wallet.periodEnd = data.currentPeriodEnd;
    } else data.wallet.autoRenew = false;
    await r.fulfill({ json: { data: { autoRenew: data.wallet.autoRenew } } });
  });
  await page.route("**/api/billing/topups/checkout-session", async (r) => {
    const body = r.request().postDataJSON();
    expect(body.amount).toBe(4700);
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    await r.fulfill({
      json: { data: { url: "/billing?topup=00000000-0000-4000-8000-000000000001" } }
    });
  });
  await page.route("**/api/billing/topups/00000000-0000-4000-8000-000000000001", (r) =>
    r.fulfill({
      json: {
        data: {
          id: "00000000-0000-4000-8000-000000000001",
          amount: 4700,
          status: "paid",
          reversed: 0
        }
      }
    })
  );
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: /Balance HK/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Top-up", exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Subscribe with balance · HKD 10/month", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Cancel balance renewal" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Subscribe · HKD 10/month", exact: true })
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel balance renewal" }).click();
  await expect(page.getByRole("button", { name: "Resume balance renewal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Top-up amount (HKD)" }).fill("9");
  await expect(page.getByRole("button", { name: "Top up with Stripe" })).toBeDisabled();
  await page.getByRole("spinbutton", { name: "Top-up amount (HKD)" }).fill("47");
  await page.getByRole("button", { name: "Top up with Stripe" }).click();
  await expect(page.getByRole("status")).toContainText("Top-up confirmed");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Top up with Stripe" })).toBeVisible();
});

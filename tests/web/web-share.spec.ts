import { expect, test } from "@playwright/test";
import { commitInUi, createActiveUser, createNoteInUi, loginViaUi } from "./helpers";

test("publishes committed notes and invalidates unpublished shares", async ({
  context,
  page,
  request
}) => {
  const { username, password } = await createActiveUser(request, "web-share");
  await loginViaUi(page, username, password);

  await createNoteInUi(page, "/public.md", "# Public Web\n");

  await page.locator(".tabs").getByRole("button", { name: "shares" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText("Only committed notes without draft changes can be shared.")
  ).toBeVisible();

  await page.locator(".tabs").getByRole("button", { name: "version" }).click();
  await commitInUi(page, "web share publishable");

  await page.locator(".tabs").getByRole("button", { name: "shares" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Share published")).toBeVisible();
  const shareLink = page.getByRole("link", { name: "/public.md" });
  await expect(shareLink).toBeVisible();
  const href = await shareLink.getAttribute("href");
  expect(href).toBeTruthy();

  const publicPage = await context.newPage();
  await publicPage.goto(href!);
  await expect(publicPage.getByRole("heading", { name: "/public.md" })).toBeVisible();
  await expect(publicPage.getByRole("heading", { name: "Public Web" })).toBeVisible();

  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByText("Share removed")).toBeVisible();
  await publicPage.reload();
  await expect(publicPage.getByText("Share not found.")).toBeVisible();
});

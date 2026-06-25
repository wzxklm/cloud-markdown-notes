import { expect, test } from "@playwright/test";
import {
  commitInUi,
  createActiveUser,
  createNoteInUi,
  loginViaUi,
  makeZipFixture
} from "./helpers";

test("searches notes and imports/exports zip archives", async ({ page, request }) => {
  const { username, password } = await createActiveUser(request, "web-transfer");
  await loginViaUi(page, username, password);

  await page.getByLabel("New folder").fill("/search");
  await page.getByRole("button", { name: "Mkdir" }).click();
  await expect(page.getByText("Folder created")).toBeVisible();
  await createNoteInUi(page, "/search/a.md", "# Search\n\nAction Item\nclosing\n");
  await page.getByLabel("New folder").fill("/search/empty");
  await page.getByRole("button", { name: "Mkdir" }).click();
  await expect(page.getByText("Folder created")).toBeVisible();
  await commitInUi(page, "web transfer initial");

  await page.locator(".tabs").getByRole("button", { name: "search" }).click();
  await page.getByLabel("Glob pattern").fill("**/*");
  await page.getByRole("button", { name: "Glob" }).click();
  await expect(page.getByRole("button", { name: "/search/a.md" })).toBeVisible();
  await expect(page.getByText("/search/empty")).toBeVisible();

  await page.getByLabel("Search text").fill("action item");
  await page.getByLabel("Search glob").fill("search/**/*.md");
  await page.getByLabel("Ignore case").check();
  await page.getByRole("button", { name: "Grep" }).click();
  await expect(page.locator(".tool-panel")).toContainText("/search/a.md:3");
  await expect(page.locator(".tool-panel")).toContainText("Action Item");

  await page.getByLabel("Search text").fill("Action\\s+Item");
  await page.getByLabel("Regex").check();
  await page.getByRole("button", { name: "Grep" }).click();
  await expect(page.locator(".tool-panel")).toContainText("/search/a.md:3");

  await page.getByRole("button", { name: "/search/a.md:3" }).click();
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
  await expect(page.locator(".toolbar strong")).toHaveText("/search/a.md");
  await expect(page.getByLabel("Read path")).toHaveValue("/search/a.md");

  await page.getByLabel("Read offset").fill("3");
  await page.getByLabel("Read limit").fill("1");
  await page.getByRole("button", { name: "Read" }).click();
  await expect(page.locator(".read-box")).toContainText("Action Item");

  await page.locator(".tabs").getByRole("button", { name: "transfer" }).click();
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByText("Choose a zip file first.")).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Choose a zip file first.")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export zip" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("notes.zip");
  await expect(page.getByText("Zip exported")).toBeVisible();

  const conflictZip = await makeZipFixture("conflict", {
    "search/a.md": "# Conflict\n"
  });
  await page.getByLabel("Import zip").setInputFiles(conflictZip);
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByText("1 conflicts")).toBeVisible();
  await expect(page.getByText("/search/a.md: Path already exists.")).toBeVisible();

  const importZip = await makeZipFixture("import", {
    "imported/": new Uint8Array(0),
    "imported/empty/": new Uint8Array(0),
    "imported/web.md": "# Imported from Web\n"
  });
  await page.getByLabel("Import zip").setInputFiles(importZip);
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByText("1 files, 2 folders, 0 conflicts")).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Zip imported")).toBeVisible();
  await expect(page.getByRole("button", { name: "web.md" })).toBeVisible();
  await page.getByRole("button", { name: "web.md" }).click();
  await expect(page.getByRole("heading", { name: "Imported from Web" })).toBeVisible();
});

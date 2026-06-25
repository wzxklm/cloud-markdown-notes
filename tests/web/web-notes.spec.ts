import { expect, test } from "@playwright/test";
import { commitInUi, createActiveUser, createNoteInUi, loginViaUi } from "./helpers";

test("creates, edits, versions, moves, restores, discards, and deletes notes", async ({
  page,
  request
}) => {
  const { username, password } = await createActiveUser(request, "web-notes");
  await loginViaUi(page, username, password);

  await page.getByLabel("New folder").fill("/docs");
  await page.getByRole("button", { name: "Mkdir" }).click();
  await expect(page.getByText("Folder created")).toBeVisible();
  await expect(page.getByRole("button", { name: "docs" })).toBeVisible();
  await page.getByLabel("New folder").fill("/docs/empty");
  await page.getByRole("button", { name: "Mkdir" }).click();
  await expect(page.getByText("Folder created")).toBeVisible();
  await expect(page.getByRole("button", { name: "empty" })).toBeVisible();

  await createNoteInUi(page, "/docs/a.md", "# Alpha\n\nAction Item\n");
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect(page.locator(".markdown-preview")).toContainText("Action Item");
  await expect(page.getByText("untracked /docs/a.md")).toBeVisible();

  await createNoteInUi(
    page,
    "/docs/fenced.md",
    [
      "# Fenced copy block",
      "",
      "`````text",
      "Copy this whole block.",
      "",
      "```bash",
      "notes health --json",
      "```",
      "`````",
      ""
    ].join("\n")
  );
  await expect(page.getByRole("heading", { name: "Fenced copy block" })).toBeVisible();
  const previewCodeBlocks = page.locator(".markdown-preview pre");
  await expect(previewCodeBlocks).toHaveCount(1);
  await expect(previewCodeBlocks.first()).toContainText("```bash");
  await expect(previewCodeBlocks.first()).toContainText("notes health --json");

  await page.getByRole("button", { name: "a.md" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();

  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.locator(".diff-box")).toContainText("+# Alpha");

  await commitInUi(page, "web notes initial");
  await expect(page.getByText("web notes initial")).toBeVisible();
  await page.getByRole("button", { name: "Show" }).first().click();
  await expect(page.getByRole("heading", { name: "Commit" })).toBeVisible();
  await expect(page.locator(".commit-summary")).toContainText("web notes initial");
  await expect(page.locator(".commit-diff")).toContainText("+# Alpha");

  await page.getByLabel("Markdown editor").fill("# Beta\n\nAction Item\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved");
  await expect(page.getByText("modified /docs/a.md")).toBeVisible();

  await page.getByRole("button", { name: "Diff" }).click();
  await expect(page.locator(".diff-box")).toContainText("-# Alpha");
  await expect(page.locator(".diff-box")).toContainText("+# Beta");

  await page
    .getByRole("button", { name: /[0-9a-f]{10}/ })
    .first()
    .click();
  const firstCommit = await page.getByLabel("Restore commit").inputValue();
  await page.getByLabel("Restore path").fill("/docs/a.md");
  await page.getByLabel("Restore type").selectOption("file");
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Path restored")).toBeVisible();
  await page.getByRole("button", { name: "a.md" }).click();
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();

  await page.getByLabel("Move from").fill("/docs/a.md");
  await page.getByLabel("Move to").fill("/docs/b.md");
  await page.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Path moved")).toBeVisible();
  await expect(page.locator(".toolbar strong")).toHaveText("/docs/b.md");

  await page.getByLabel("Move from").fill("/docs/empty");
  await page.getByLabel("Move to").fill("/docs/empty-moved");
  await page.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText("Path moved")).toBeVisible();
  await expect(page.getByRole("button", { name: "empty-moved" })).toBeVisible();

  await page.getByRole("button", { name: "empty-moved" }).click();
  await expect(page.locator(".toolbar strong")).toHaveText("/docs/empty-moved");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No note selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "empty-moved" })).toHaveCount(0);
  await page.getByRole("button", { name: "b.md" }).click();
  await expect(page.locator(".toolbar strong")).toHaveText("/docs/b.md");

  await page.getByLabel("Markdown editor").fill("# Draft before discard\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Changes discarded")).toBeVisible();
  await expect(page.getByText("No note selected")).toBeVisible();

  await page.getByLabel("Restore commit").fill(firstCommit);
  await page.getByLabel("Restore path").fill("/docs/empty");
  await page.getByLabel("Restore type").selectOption("folder");
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Path restored")).toBeVisible();
  await expect(page.getByRole("button", { name: "empty" })).toBeVisible();

  await page.getByRole("button", { name: "a.md" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No note selected")).toBeVisible();

  await page.getByLabel("Restore path").fill("/docs/a.md");
  await page.getByLabel("Restore type").selectOption("folder");
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("The path is invalid.")).toBeVisible();

  await page.getByLabel("New note").fill("invalid.md");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("The path is invalid.")).toBeVisible();
});

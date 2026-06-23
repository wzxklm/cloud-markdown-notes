import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { strToU8, zipSync, type Zippable } from "fflate";

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "pending";
};

type ApiSuccess<T> = {
  data: T;
};

export const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
export const adminPassword = process.env.ADMIN_PASSWORD ?? "admin-password";
export const apiBaseURL = resolveApiBaseURL();

function resolveApiBaseURL(): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/api\/?$/, "");
  }

  return process.env.NOTES_API_URL ?? "http://127.0.0.1:3000";
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createActiveUser(
  request: APIRequestContext,
  prefix: string
): Promise<{ username: string; password: string; user: PublicUser }> {
  const username = uniqueName(prefix);
  const password = `${username}-password`;
  const registered = await apiPost<ApiSuccess<{ user: PublicUser }>>(
    request,
    "/api/auth/register",
    {
      username,
      password
    }
  );
  expect(registered.data.user.status).toBe("pending");

  const admin = await apiPost<ApiSuccess<{ token: string; user: PublicUser }>>(
    request,
    "/api/auth/login",
    {
      username: adminUsername,
      password: adminPassword
    }
  );
  const pending = await apiGet<ApiSuccess<{ users: PublicUser[] }>>(
    request,
    "/api/admin/users/pending",
    {
      token: admin.data.token
    }
  );
  const user = pending.data.users.find((candidate) => candidate.username === username);
  expect(user).toBeTruthy();

  const activated = await apiPost<ApiSuccess<{ user: PublicUser }>>(
    request,
    `/api/admin/users/${encodeURIComponent(user!.id)}/activate`,
    undefined,
    { token: admin.data.token }
  );
  expect(activated.data.user.status).toBe("active");
  return { username, password, user: activated.data.user };
}

export async function loginViaUi(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.locator(".segmented").getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).last().click();
  await expect(page.getByText(`${username} · user`)).toBeVisible();
  await expect(page.getByText("No note selected")).toBeVisible();
}

export async function createNoteInUi(page: Page, notePath: string, content: string): Promise<void> {
  await page.getByLabel("New note").fill(notePath);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Note created")).toBeVisible();
  await page.getByLabel("Markdown editor").fill(content);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".notice")).toHaveText("Saved");
  await expect(page.locator(".toolbar strong")).toHaveText(notePath);
}

export async function commitInUi(page: Page, message: string): Promise<void> {
  await page.getByLabel("Commit message").fill(message);
  await page.getByRole("button", { name: "Commit" }).click();
  await expect(page.locator(".notice")).toHaveText(/Committed [0-9a-f]{12}/);
  await expect(page.getByText("Clean")).toBeVisible();
}

export async function makeZipFixture(
  name: string,
  entries: Record<string, string | Uint8Array>
): Promise<string> {
  const root = path.resolve("runtime", "fulltest-docker", "runner", "web-fixtures");
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, `${name}-${Date.now().toString(36)}.zip`);
  const zippable: Zippable = {};
  for (const [zipPath, content] of Object.entries(entries)) {
    zippable[zipPath] = typeof content === "string" ? strToU8(content) : content;
  }
  await writeFile(filePath, zipSync(zippable, { level: 6 }));
  return filePath;
}

async function apiGet<T>(
  request: APIRequestContext,
  pathname: string,
  options: { token?: string } = {}
): Promise<T> {
  const response = await request.get(`${apiBaseURL}${pathname}`, {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : undefined
  });
  return parseApiResponse<T>(response, pathname);
}

async function apiPost<T>(
  request: APIRequestContext,
  pathname: string,
  body?: unknown,
  options: { token?: string } = {}
): Promise<T> {
  const response = await request.post(`${apiBaseURL}${pathname}`, {
    data: body,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : undefined
  });
  return parseApiResponse<T>(response, pathname);
}

async function parseApiResponse<T>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  pathname: string
): Promise<T> {
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`${pathname} returned ${response.status()}.\n${text}`);
  }

  return JSON.parse(text) as T;
}

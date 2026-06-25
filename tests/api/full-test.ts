import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

type ApiSuccess<T> = {
  data: T;
};

type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "pending";
};

type LoginData = {
  token: string;
  user: PublicUser;
};

type Note = {
  path: string;
  content: string;
  fileVersion: string;
};

type Commit = {
  sha: string;
  message: string;
  committedAt?: string;
};

type CommitDetail = {
  commit: Commit;
  diff: string;
};

type Share = {
  id: string;
  notePath: string;
  slug: string;
  url: string;
  commitSha: string;
  active: boolean;
};

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  expectedStatus?: number;
};

const apiBaseUrl = resolveApiBaseUrl();
const publicBaseUrl = new URL("../", apiBaseUrl);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin-password";

function resolveApiBaseUrl(): URL {
  const configured = process.env.API_BASE_URL ?? "http://127.0.0.1:3000/api";
  return new URL(configured.endsWith("/") ? configured : `${configured}/`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertErrorCode(body: ApiErrorBody, code: string): void {
  assertEqual(body.error.code, code, `Expected API error ${code}`);
}

function apiPath(pathname: string): URL {
  return new URL(pathname.replace(/^\/+/, ""), apiBaseUrl);
}

function publicPath(pathname: string): URL {
  return new URL(pathname.replace(/^\/+/, ""), publicBaseUrl);
}

async function apiJson<T>(pathname: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    ...options.headers
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const init: RequestInit = {
    method,
    headers
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  } else if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  }

  const url = apiPath(pathname);
  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  const expectedStatus =
    options.expectedStatus ?? (method === "POST" && pathname === "auth/register" ? 201 : 200);

  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${url.pathname} returned ${response.status}, expected ${expectedStatus}.\n${text}`
    );
  }

  return parsed as T;
}

async function publicJson<T>(pathname: string, expectedStatus = 200): Promise<T> {
  const url = publicPath(pathname);
  const response = await fetch(url);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `GET ${url.pathname} returned ${response.status}, expected ${expectedStatus}.\n${text}`
    );
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

async function publicPostJson<T>(
  pathname: string,
  body: unknown,
  expectedStatus = 200
): Promise<T> {
  const url = publicPath(pathname);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${url.pathname} returned ${response.status}, expected ${expectedStatus}.\n${text}`
    );
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

async function apiBinary(pathname: string, token: string): Promise<Uint8Array> {
  const url = apiPath(pathname);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`GET ${url.pathname} returned ${response.status}.\n${await response.text()}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function step(name: string, action: () => Promise<void>): Promise<void> {
  process.stdout.write(`[api-full] ${name}\n`);
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[api-full] ${name} failed:\n${message}`);
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const body = await apiJson<ApiSuccess<{ status: string; database: string }>>("health");
      if (body.data.status === "ok" && body.data.database === "ok") {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`API did not become healthy at ${apiBaseUrl.href}.\n${lastError}`);
}

async function login(username: string, password: string): Promise<LoginData> {
  const response = await apiJson<ApiSuccess<LoginData>>("auth/login", {
    method: "POST",
    body: { username, password }
  });
  return response.data;
}

async function register(username: string, password: string): Promise<PublicUser> {
  const response = await apiJson<ApiSuccess<{ user: PublicUser }>>("auth/register", {
    method: "POST",
    expectedStatus: 201,
    body: { username, password }
  });
  return response.data.user;
}

async function activateUser(adminToken: string, username: string): Promise<PublicUser> {
  const pending = await apiJson<ApiSuccess<{ users: PublicUser[] }>>("admin/users/pending", {
    token: adminToken
  });
  const user = pending.data.users.find((candidate) => candidate.username === username);
  assert(user, `Pending user ${username} was not listed.`);
  const activated = await apiJson<ApiSuccess<{ user: PublicUser }>>(
    `admin/users/${encodeURIComponent(user.id)}/activate`,
    {
      method: "POST",
      token: adminToken
    }
  );
  assertEqual(activated.data.user.status, "active", "Activated user status");
  return activated.data.user;
}

async function registerActiveUser(
  adminToken: string,
  username: string,
  password: string
): Promise<LoginData> {
  await register(username, password);
  await activateUser(adminToken, username);
  return login(username, password);
}

async function readNote(token: string, notePath: string): Promise<Note> {
  const response = await apiJson<ApiSuccess<{ note: Note }>>(
    `notes?path=${encodeURIComponent(notePath)}`,
    { token }
  );
  return response.data.note;
}

async function replaceNote(token: string, notePath: string, content: string): Promise<Note> {
  const current = await readNote(token, notePath);
  const response = await apiJson<ApiSuccess<{ note: Note }>>(
    `notes?path=${encodeURIComponent(notePath)}`,
    {
      method: "PUT",
      token,
      body: {
        content,
        ifMatch: current.fileVersion
      }
    }
  );
  return response.data.note;
}

async function commit(token: string, message: string): Promise<Commit> {
  const response = await apiJson<ApiSuccess<{ commit: Commit }>>("version/commit", {
    method: "POST",
    token,
    body: { message }
  });
  assert(/^[0-9a-f]{40}$/.test(response.data.commit.sha), "Commit sha should be a full git sha.");
  return response.data.commit;
}

function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const [zipPath, content] of Object.entries(entries)) {
    zippable[zipPath] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zippable, { level: 6 });
}

async function seedNoteLimitFiles(userId: string): Promise<void> {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/data/workspaces";
  const bulkPath = path.join(workspaceRoot, userId, "bulk");
  await mkdir(bulkPath, { recursive: true });
  await Promise.all(
    Array.from({ length: 1000 }, (_value, index) =>
      writeFile(path.join(bulkPath, `${index}.md`), `# ${index}\n`, "utf8")
    )
  );
}

async function main(): Promise<void> {
  let adminToken = "";
  let userToken = "";
  let user: PublicUser | undefined;
  let firstCommitSha = "";

  const username = `api-${suffix}`;
  const password = `api-password-${suffix}`;
  const isolatedUsername = `api-isolated-${suffix}`;
  const limitUsername = `api-limit-${suffix}`;

  await step("wait for real API health", waitForHealth);

  await step("admin login", async () => {
    const loginData = await login(adminUsername, adminPassword);
    adminToken = loginData.token;
    assertEqual(loginData.user.role, "admin", "Admin role");
  });

  await step("register pending user and reject pending login", async () => {
    const registered = await register(username, password);
    assertEqual(registered.status, "pending", "Registered user status");
    const duplicate = await publicPostJson<ApiErrorBody>(
      "api/auth/register",
      { username, password },
      409
    );
    assertErrorCode(duplicate, "USER_ALREADY_EXISTS");
    const invalidRegister = await publicPostJson<ApiErrorBody>(
      "api/auth/register",
      { username: "", password: "" },
      400
    );
    assertErrorCode(invalidRegister, "VALIDATION_ERROR");
    const invalidPassword = await apiJson<ApiErrorBody>("auth/login", {
      method: "POST",
      expectedStatus: 401,
      body: { username, password: `${password}-wrong` }
    });
    assertErrorCode(invalidPassword, "INVALID_CREDENTIALS");
    const pendingLogin = await apiJson<ApiErrorBody>("auth/login", {
      method: "POST",
      expectedStatus: 403,
      body: { username, password }
    });
    assertErrorCode(pendingLogin, "USER_PENDING");
  });

  await step("admin activates user and authenticated session works", async () => {
    user = await activateUser(adminToken, username);
    const regularLogin = await login(username, password);
    const forbiddenPendingUsers = await apiJson<ApiErrorBody>("admin/users/pending", {
      token: regularLogin.token,
      expectedStatus: 403
    });
    assertErrorCode(forbiddenPendingUsers, "FORBIDDEN");
    const missingActivation = await apiJson<ApiErrorBody>(
      "admin/users/00000000-0000-0000-0000-000000000000/activate",
      {
        method: "POST",
        token: adminToken,
        expectedStatus: 404
      }
    );
    assertErrorCode(missingActivation, "USER_NOT_FOUND");
    const loginData = await login(username, password);
    userToken = loginData.token;
    const me = await apiJson<ApiSuccess<{ user: PublicUser }>>("auth/me", { token: userToken });
    assertEqual(me.data.user.username, username, "Current username");
    const missingAuth = await apiJson<ApiErrorBody>("auth/me", {
      expectedStatus: 401
    });
    assertErrorCode(missingAuth, "UNAUTHENTICATED");
    await apiJson<ApiSuccess<{ ok: true }>>("auth/logout", {
      method: "POST",
      token: userToken
    });
    const invalidMe = await apiJson<ApiErrorBody>("auth/me", {
      token: userToken,
      expectedStatus: 401
    });
    assertErrorCode(invalidMe, "UNAUTHENTICATED");
    userToken = (await login(username, password)).token;
  });

  await step("folders and notes create list move delete", async () => {
    const missingFolderAuth = await apiJson<ApiErrorBody>("folders?path=%2F", {
      expectedStatus: 401
    });
    assertErrorCode(missingFolderAuth, "UNAUTHENTICATED");
    const invalidRelativePath = await apiJson<ApiErrorBody>("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { path: "relative" }
    });
    assertErrorCode(invalidRelativePath, "PATH_INVALID");
    const rootFolderCreate = await apiJson<ApiErrorBody>("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      body: { path: "/" }
    });
    assertErrorCode(rootFolderCreate, "PATH_ALREADY_EXISTS");
    await apiJson("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/notes" }
    });
    const duplicateFolder = await apiJson<ApiErrorBody>("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      body: { path: "/notes" }
    });
    assertErrorCode(duplicateFolder, "PATH_ALREADY_EXISTS");
    await apiJson("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/archive" }
    });
    await apiJson("folders/move", {
      method: "PATCH",
      token: userToken,
      body: { fromPath: "/archive", toPath: "/notes/archive" }
    });
    const created = await apiJson<ApiSuccess<{ note: Note }>>("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/notes/a.md", content: "Intro\nAction Item\nclosing\n" }
    });
    const duplicateNote = await apiJson<ApiErrorBody>("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      body: { path: "/notes/a.md", content: "# Duplicate\n" }
    });
    assertErrorCode(duplicateNote, "PATH_ALREADY_EXISTS");
    const invalidNoteExtension = await apiJson<ApiErrorBody>("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { path: "/notes/plain.txt", content: "plain\n" }
    });
    assertErrorCode(invalidNoteExtension, "PATH_INVALID");
    const missingParent = await apiJson<ApiErrorBody>("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 404,
      body: { path: "/missing/parent.md", content: "# Missing\n" }
    });
    assertErrorCode(missingParent, "PATH_NOT_FOUND");
    const missingIfMatch = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PUT",
      token: userToken,
      expectedStatus: 400,
      body: { content: "# Missing ifMatch\n" }
    });
    assertErrorCode(missingIfMatch, "VALIDATION_ERROR");
    const conflict = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PUT",
      token: userToken,
      expectedStatus: 409,
      body: { content: "# Conflict\n", ifMatch: "stale-version" }
    });
    assertErrorCode(conflict, "EDIT_CONFLICT");
    const replaced = await apiJson<ApiSuccess<{ note: Note }>>("notes?path=%2Fnotes%2Fa.md", {
      method: "PUT",
      token: userToken,
      body: {
        content: "# A\nAction Item\nclosing\n",
        ifMatch: created.data.note.fileVersion
      }
    });
    assertEqual(replaced.data.note.content, "# A\nAction Item\nclosing\n", "Replaced note content");
    const edited = await apiJson<ApiSuccess<{ note: Note }>>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      body: {
        ifMatch: replaced.data.note.fileVersion,
        fromLine: 2,
        toLine: 2,
        content: "First action\nSecond action"
      }
    });
    assertEqual(
      edited.data.note.content,
      "# A\nFirst action\nSecond action\nclosing\n",
      "Edited note content"
    );
    const deletedLines = await apiJson<ApiSuccess<{ note: Note }>>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      body: {
        ifMatch: edited.data.note.fileVersion,
        fromLine: 2,
        toLine: 3,
        content: ""
      }
    });
    assertEqual(deletedLines.data.note.content, "# A\nclosing\n", "Deleted note line range");
    const editConflict = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 409,
      body: { ifMatch: "stale-version", fromLine: 1, toLine: 1, content: "# Stale" }
    });
    assertErrorCode(editConflict, "EDIT_CONFLICT");
    const invalidEditRange = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 400,
      body: {
        ifMatch: deletedLines.data.note.fileVersion,
        fromLine: 3,
        toLine: 3,
        content: "outside"
      }
    });
    assertErrorCode(invalidEditRange, "VALIDATION_ERROR");
    const invalidEditOrder = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 400,
      body: {
        ifMatch: deletedLines.data.note.fileVersion,
        fromLine: 2,
        toLine: 1,
        content: "invalid"
      }
    });
    assertErrorCode(invalidEditOrder, "VALIDATION_ERROR");
    const missingEditLine = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fa.md", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 400,
      body: {
        ifMatch: deletedLines.data.note.fileVersion,
        fromLine: 1,
        content: "missing"
      }
    });
    assertErrorCode(missingEditLine, "VALIDATION_ERROR");
    await apiJson("notes?path=%2Fnotes%2Fa.md", {
      method: "PUT",
      token: userToken,
      body: {
        content: "# A\nAction Item\nclosing\n",
        ifMatch: deletedLines.data.note.fileVersion
      }
    });
    await apiJson("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/notes/temp.md", content: "temporary\n" }
    });
    await apiJson("notes/move", {
      method: "PATCH",
      token: userToken,
      body: { fromPath: "/notes/temp.md", toPath: "/notes/moved.md" }
    });
    const missingNoteMove = await apiJson<ApiErrorBody>("notes/move", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 404,
      body: { fromPath: "/notes/nope.md", toPath: "/notes/nope-moved.md" }
    });
    assertErrorCode(missingNoteMove, "PATH_NOT_FOUND");
    await apiJson("notes?path=%2Fnotes%2Fmoved.md", {
      method: "DELETE",
      token: userToken
    });
    const missingNoteDelete = await apiJson<ApiErrorBody>("notes?path=%2Fnotes%2Fmoved.md", {
      method: "DELETE",
      token: userToken,
      expectedStatus: 404
    });
    assertErrorCode(missingNoteDelete, "PATH_NOT_FOUND");
    await apiJson("folders", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/delete-me" }
    });
    await apiJson("folders?path=%2Fdelete-me", {
      method: "DELETE",
      token: userToken
    });
    const missingFolderRead = await apiJson<ApiErrorBody>("folders?path=%2Fdelete-me", {
      token: userToken,
      expectedStatus: 404
    });
    assertErrorCode(missingFolderRead, "PATH_NOT_FOUND");
    const selfMove = await apiJson<ApiErrorBody>("folders/move", {
      method: "PATCH",
      token: userToken,
      expectedStatus: 400,
      body: { fromPath: "/notes", toPath: "/notes/nested" }
    });
    assertErrorCode(selfMove, "PATH_INVALID");
    const list = await apiJson<ApiSuccess<{ entries: { path: string; type: string }[] }>>(
      "folders?path=%2Fnotes",
      { token: userToken }
    );
    assert(
      list.data.entries.some((entry) => entry.path === "/notes/a.md"),
      "Folder list should include note."
    );
  });

  await step("user workspaces stay isolated", async () => {
    await apiJson("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/private.md", content: "# Private\n" }
    });
    const isolated = await registerActiveUser(
      adminToken,
      isolatedUsername,
      `isolated-password-${suffix}`
    );
    const readPrivate = await apiJson<ApiErrorBody>("notes?path=%2Fprivate.md", {
      token: isolated.token,
      expectedStatus: 404
    });
    assertErrorCode(readPrivate, "PATH_NOT_FOUND");
    const isolatedRoot = await apiJson<ApiSuccess<{ entries: unknown[] }>>("folders?path=%2F", {
      token: isolated.token
    });
    assertEqual(isolatedRoot.data.entries.length, 0, "Isolated user root entry count");
  });

  await step("version status diff commit history discard restore", async () => {
    const status = await apiJson<ApiSuccess<{ changes: { path: string; changeType: string }[] }>>(
      "version/status",
      { token: userToken }
    );
    assert(
      status.data.changes.some((change) => change.path === "/notes/a.md"),
      "Status should include /notes/a.md."
    );
    await apiJson("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/notes/开发习惯.md", content: "# 开发习惯\n" }
    });
    const unicodeStatus = await apiJson<
      ApiSuccess<{ changes: { path: string; changeType: string }[] }>
    >("version/status", { token: userToken });
    assert(
      unicodeStatus.data.changes.some((change) => change.path === "/notes/开发习惯.md"),
      "Status should preserve non-ASCII note paths."
    );
    const diff = await apiJson<ApiSuccess<{ diff: string }>>("version/diff", { token: userToken });
    assert(diff.data.diff.includes("+# A"), "Diff should include note content.");
    assert(
      diff.data.diff.includes("notes/开发习惯.md"),
      "Diff should preserve non-ASCII note paths."
    );
    const emptyMessage = await apiJson<ApiErrorBody>("version/commit", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { message: "   " }
    });
    assertErrorCode(emptyMessage, "COMMIT_MESSAGE_REQUIRED");
    const invalidRestoreSha = await apiJson<ApiErrorBody>("version/restore", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: {
        commitSha: "not-a-sha",
        path: "/notes/a.md",
        type: "file"
      }
    });
    assertErrorCode(invalidRestoreSha, "VALIDATION_ERROR");
    firstCommitSha = (await commit(userToken, "api full initial")).sha;
    const clean = await apiJson<ApiSuccess<{ changes: unknown[] }>>("version/status", {
      token: userToken
    });
    assertEqual(clean.data.changes.length, 0, "Clean status changes");
    const noChanges = await apiJson<ApiErrorBody>("version/commit", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      body: { message: "empty" }
    });
    assertErrorCode(noChanges, "NO_CHANGES_TO_COMMIT");
    const history = await apiJson<ApiSuccess<{ commits: Commit[] }>>("version/history", {
      token: userToken
    });
    assertEqual(history.data.commits[0]?.message, "api full initial", "Latest history message");
    const show = await apiJson<ApiSuccess<{ show: CommitDetail }>>(
      `version/show?commit=${firstCommitSha}`,
      { token: userToken }
    );
    assertEqual(show.data.show.commit.sha, firstCommitSha, "Show commit sha");
    assertEqual(show.data.show.commit.message, "api full initial", "Show commit message");
    assert(show.data.show.diff.includes("+# A"), "Show diff should include added note.");
    assert(
      show.data.show.diff.includes("notes/开发习惯.md"),
      "Show diff should preserve non-ASCII note paths."
    );
    const invalidShowSha = await apiJson<ApiErrorBody>("version/show?commit=not-a-sha", {
      token: userToken,
      expectedStatus: 400
    });
    assertErrorCode(invalidShowSha, "VALIDATION_ERROR");
    const missingShowCommit = await apiJson<ApiErrorBody>("version/show?commit=abcdef0", {
      token: userToken,
      expectedStatus: 404
    });
    assertErrorCode(missingShowCommit, "PATH_NOT_FOUND");
    const missingCommit = await apiJson<ApiErrorBody>("version/restore", {
      method: "POST",
      token: userToken,
      expectedStatus: 404,
      body: {
        commitSha: "abcdef0",
        path: "/notes/a.md",
        type: "file"
      }
    });
    assertErrorCode(missingCommit, "PATH_NOT_FOUND");
    await replaceNote(userToken, "/notes/a.md", "# Draft\nAction Item\nclosing\n");
    const draftDiff = await apiJson<ApiSuccess<{ diff: string }>>("version/diff", {
      token: userToken
    });
    assert(draftDiff.data.diff.includes("-# A"), "Draft diff should show removed line.");
    assert(draftDiff.data.diff.includes("+# Draft"), "Draft diff should show added line.");
    await apiJson("version/discard", { method: "POST", token: userToken });
    assertEqual(
      (await readNote(userToken, "/notes/a.md")).content,
      "# A\nAction Item\nclosing\n",
      "Discarded content"
    );
    await replaceNote(userToken, "/notes/a.md", "# Second\nAction Item\nclosing\n");
    await apiJson("folders?path=%2Fnotes%2Farchive", {
      method: "DELETE",
      token: userToken
    });
    await commit(userToken, "api full second");
    await apiJson("version/restore", {
      method: "POST",
      token: userToken,
      body: {
        commitSha: firstCommitSha,
        path: "/notes/a.md",
        type: "file"
      }
    });
    assertEqual(
      (await readNote(userToken, "/notes/a.md")).content,
      "# A\nAction Item\nclosing\n",
      "Restored file content"
    );
    const mismatchedRestoreType = await apiJson<ApiErrorBody>("version/restore", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: {
        commitSha: firstCommitSha,
        path: "/notes/a.md",
        type: "folder"
      }
    });
    assertErrorCode(mismatchedRestoreType, "PATH_INVALID");
    await apiJson("version/discard", { method: "POST", token: userToken });
    await apiJson("version/restore", {
      method: "POST",
      token: userToken,
      body: {
        commitSha: firstCommitSha,
        path: "/notes",
        type: "folder"
      }
    });
    const tree = await apiJson<
      ApiSuccess<{ tree: { children?: { path: string; children?: { path: string }[] }[] } }>
    >("tree", { token: userToken });
    const notes = tree.data.tree.children?.find((entry) => entry.path === "/notes");
    assert(
      notes?.children?.some((entry) => entry.path === "/notes/archive"),
      "Restored folder should include empty archive."
    );
  });

  await step("glob grep read extensions", async () => {
    const invalidGlob = await apiJson<ApiErrorBody>("search/glob", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { pattern: "../**/*" }
    });
    assertErrorCode(invalidGlob, "GLOB_INVALID");
    const glob = await apiJson<ApiSuccess<{ matches: { path: string; type: string }[] }>>(
      "search/glob",
      {
        method: "POST",
        token: userToken,
        body: { pattern: "**/*" }
      }
    );
    assert(
      glob.data.matches.some((match) => match.path === "/notes/a.md"),
      "Glob should find note."
    );
    assert(
      glob.data.matches.some((match) => match.path === "/notes/archive"),
      "Glob should find empty folder."
    );
    const grep = await apiJson<
      ApiSuccess<{ matches: { path: string; lineNumber: number; line: string }[] }>
    >("search/grep", {
      method: "POST",
      token: userToken,
      body: {
        pattern: "action item",
        ignoreCase: true,
        glob: "notes/**/*.md",
        context: 1
      }
    });
    assertEqual(grep.data.matches[0]?.line, "Action Item", "Grep match line");
    const regex = await apiJson<ApiSuccess<{ matches: unknown[] }>>("search/grep", {
      method: "POST",
      token: userToken,
      body: { pattern: "Action\\s+Item", regex: true }
    });
    assertEqual(regex.data.matches.length, 1, "Regex grep match count");
    const invalidRegex = await apiJson<ApiErrorBody>("search/grep", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { pattern: "[", regex: true }
    });
    assertErrorCode(invalidRegex, "REGEX_INVALID");
    const invalidGrepFlag = await apiJson<ApiErrorBody>("search/grep", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { pattern: "Action", regex: "yes" }
    });
    assertErrorCode(invalidGrepFlag, "VALIDATION_ERROR");
    const read = await apiJson<
      ApiSuccess<{ note: Note & { lines: { lineNumber: number; content: string }[] } }>
    >("search/read?path=%2Fnotes%2Fa.md&offset=2&limit=1", { token: userToken });
    assertEqual(read.data.note.content, "Action Item", "Read line content");
    const invalidReadOffset = await apiJson<ApiErrorBody>(
      "search/read?path=%2Fnotes%2Fa.md&offset=0",
      {
        token: userToken,
        expectedStatus: 400
      }
    );
    assertErrorCode(invalidReadOffset, "VALIDATION_ERROR");
  });

  await step("zip export and import", async () => {
    const exportedBytes = await apiBinary("export.zip", userToken);
    const exported = unzipSync(exportedBytes);
    assertEqual(
      strFromU8(exported["notes/a.md"]),
      "# A\nAction Item\nclosing\n",
      "Exported note content"
    );
    assert(exported["notes/archive/"], "Export should include empty folder entry.");
    const conflictZip = makeZip({
      "notes/a.md": "# Conflict\n"
    });
    const conflict = await apiJson<ApiSuccess<{ plan: { conflicts: { path: string }[] } }>>(
      "import/dry-run",
      {
        method: "POST",
        token: userToken,
        rawBody: Buffer.from(conflictZip),
        headers: { "content-type": "application/zip" }
      }
    );
    assertEqual(conflict.data.plan.conflicts[0]?.path, "/notes/a.md", "Import conflict path");
    const conflictImport = await apiJson<ApiErrorBody>("import", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      rawBody: Buffer.from(conflictZip),
      headers: { "content-type": "application/zip" }
    });
    assertErrorCode(conflictImport, "IMPORT_CONFLICT");
    const invalidZip = await apiJson<ApiErrorBody>("import/dry-run", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      rawBody: Buffer.from("not a zip"),
      headers: { "content-type": "application/zip" }
    });
    assertErrorCode(invalidZip, "VALIDATION_ERROR");
    const unsupportedEntryZip = makeZip({
      "imported/not-markdown.txt": "Nope\n"
    });
    const unsupported = await apiJson<
      ApiSuccess<{ plan: { conflicts: { path: string; reason: string }[] } }>
    >("import/dry-run", {
      method: "POST",
      token: userToken,
      rawBody: Buffer.from(unsupportedEntryZip),
      headers: { "content-type": "application/zip" }
    });
    assertEqual(
      unsupported.data.plan.conflicts[0]?.path,
      "/imported/not-markdown.txt",
      "Unsupported import path"
    );
    const importZip = makeZip({
      "imported/": new Uint8Array(0),
      "imported/empty/": new Uint8Array(0),
      "imported/new.md": "# Imported\n"
    });
    const dryRun = await apiJson<
      ApiSuccess<{ plan: { files: string[]; folders: string[]; conflicts: unknown[] } }>
    >("import/dry-run", {
      method: "POST",
      token: userToken,
      rawBody: Buffer.from(importZip),
      headers: { "content-type": "application/zip" }
    });
    assert(
      dryRun.data.plan.files.includes("/imported/new.md"),
      "Dry run should include imported file."
    );
    assertEqual(dryRun.data.plan.conflicts.length, 0, "Dry run conflicts");
    await apiJson("import", {
      method: "POST",
      token: userToken,
      rawBody: Buffer.from(importZip),
      headers: { "content-type": "application/zip" }
    });
    assertEqual(
      (await readNote(userToken, "/imported/new.md")).content,
      "# Imported\n",
      "Imported note content"
    );
  });

  await step("share publish public read unpublish and deleted note invalidation", async () => {
    await apiJson("notes", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/public.md", content: "# Public\n" }
    });
    const uncommittedPublish = await apiJson<ApiErrorBody>("shares", {
      method: "POST",
      token: userToken,
      expectedStatus: 409,
      body: { path: "/public.md" }
    });
    assertErrorCode(uncommittedPublish, "NOTE_NOT_COMMITTED");
    const invalidSharePath = await apiJson<ApiErrorBody>("shares", {
      method: "POST",
      token: userToken,
      expectedStatus: 400,
      body: { path: "/public.txt" }
    });
    assertErrorCode(invalidSharePath, "PATH_INVALID");
    const publishCommit = await commit(userToken, "api full publishable");
    const published = await apiJson<ApiSuccess<{ share: Share }>>("shares", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/public.md" }
    });
    assertEqual(published.data.share.commitSha, publishCommit.sha, "Share commit sha");
    assert(published.data.share.url.includes("/s/"), "Share URL should include /s/.");
    const publicShare = await publicJson<ApiSuccess<{ share: Share & { content: string } }>>(
      `s/${published.data.share.slug}`
    );
    assertEqual(publicShare.data.share.content, "# Public\n", "Public share content");
    const publicApiShare = await publicJson<ApiSuccess<{ share: Share & { content: string } }>>(
      `api/shares/public/${published.data.share.slug}`
    );
    assertEqual(publicApiShare.data.share.content, "# Public\n", "Public API share content");
    await replaceNote(userToken, "/public.md", "# Draft\n");
    const draftShare = await publicJson<ApiSuccess<{ share: Share & { content: string } }>>(
      `s/${published.data.share.slug}`
    );
    assertEqual(
      draftShare.data.share.content,
      "# Public\n",
      "Share should serve committed content"
    );
    const listed = await apiJson<ApiSuccess<{ shares: Share[] }>>("shares", { token: userToken });
    assertEqual(listed.data.shares.length, 1, "Share list count");
    await apiJson(`shares/${published.data.share.id}`, {
      method: "DELETE",
      token: userToken
    });
    const duplicateUnpublish = await apiJson<ApiErrorBody>(`shares/${published.data.share.id}`, {
      method: "DELETE",
      token: userToken,
      expectedStatus: 404
    });
    assertErrorCode(duplicateUnpublish, "SHARE_NOT_FOUND");
    const unpublished = await publicJson<ApiErrorBody>(`s/${published.data.share.slug}`, 404);
    assertErrorCode(unpublished, "SHARE_NOT_FOUND");
    await apiJson("version/discard", { method: "POST", token: userToken });
    const republished = await apiJson<ApiSuccess<{ share: Share }>>("shares", {
      method: "POST",
      token: userToken,
      expectedStatus: 201,
      body: { path: "/public.md" }
    });
    await apiJson("notes?path=%2Fpublic.md", {
      method: "DELETE",
      token: userToken
    });
    await commit(userToken, "api full delete public note");
    const deletedShare = await publicJson<ApiErrorBody>(`s/${republished.data.share.slug}`, 404);
    assertErrorCode(deletedShare, "SHARE_NOT_FOUND");
  });

  await step("regular user 1000 note limit", async () => {
    const limitLogin = await registerActiveUser(
      adminToken,
      limitUsername,
      `limit-password-${suffix}`
    );
    await seedNoteLimitFiles(limitLogin.user.id);
    const limit = await apiJson<ApiErrorBody>("notes", {
      method: "POST",
      token: limitLogin.token,
      expectedStatus: 403,
      body: { path: "/overflow.md", content: "# Overflow\n" }
    });
    assertErrorCode(limit, "NOTE_LIMIT_EXCEEDED");
  });

  assert(user, "Main user should be available.");
  process.stdout.write(`[api-full] passed for ${user.username} against ${apiBaseUrl.href}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

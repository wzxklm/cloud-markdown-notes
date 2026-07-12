import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync, type Zippable } from "fflate";

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "pending";
};

type Share = {
  id: string;
  notePath: string;
  slug: string;
  url: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const execFileAsync = promisify(execFile);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin-password";
const apiUrl = process.env.NOTES_API_URL ?? "http://127.0.0.1:3000";
const hostApiUrl = apiUrl;
const workRoot = path.resolve("runtime", "fulltest-docker", "runner", "cli", suffix);
const commandWorkRoot = workRoot;
const adminConfigPath = `${commandWorkRoot}/admin-config.json`;
const userConfigPath = `${commandWorkRoot}/user-config.json`;
const cliPackageRoot = path.resolve("packages", "cli");
const cliPackRoot = path.join(workRoot, "pack");
const cliInstallRoot = path.join(workRoot, "install");
const cliBinPath = path.join(
  cliInstallRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "notes.cmd" : "notes"
);
let notesCommand = "";

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

async function step(name: string, action: () => Promise<void>): Promise<void> {
  process.stdout.write(`[cli-full] ${name}\n`);
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[cli-full] ${name} failed:\n${message}`);
  }
}

async function runNotes(
  args: string[],
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    expectFailure?: boolean;
    input?: string;
  } = {}
): Promise<CommandResult> {
  if (!notesCommand) {
    throw new Error("CLI package has not been installed.");
  }

  const commandArgs = args;
  try {
    const { stdout, stderr } = await execNotes(commandArgs, options);
    if (options.expectFailure) {
      throw new Error(
        `Command succeeded but failure was expected.\n${formatCommand(notesCommand, commandArgs)}\n${stdout}`
      );
    }
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const stdout = getProcessOutput(error, "stdout");
    const stderr = getProcessOutput(error, "stderr");
    const exitCode = getExitCode(error) ?? 1;
    if (options.expectFailure) {
      return { stdout, stderr, exitCode };
    }

    throw new Error(
      [
        `Command failed with exit code ${exitCode}:`,
        formatCommand(notesCommand, commandArgs),
        "stdout:",
        stdout,
        "stderr:",
        stderr
      ].join("\n")
    );
  }
}

async function runJson<T>(
  args: string[],
  options: {
    configPath?: string;
    input?: string;
  } = {}
): Promise<T> {
  const result = await runNotes([...args, "--json"], options);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`Command did not return valid JSON: notes ${args.join(" ")}\n${result.stdout}`);
  }
}

function execNotes(
  args: string[],
  options: { configPath?: string; env?: NodeJS.ProcessEnv; input?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      notesCommand,
      args,
      {
        cwd: commandWorkRoot,
        env: {
          ...process.env,
          NOTES_API_URL: apiUrl,
          NOTES_CONFIG_PATH: options.configPath ?? userConfigPath,
          ...options.env
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    child.stdin?.end(options.input ?? "");
  });
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function getExitCode(error: unknown): number | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

function getProcessOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (!(error instanceof Error) || !(key in error)) {
    return "";
  }

  const output = error[key as keyof Error];
  return typeof output === "string"
    ? output
    : Buffer.isBuffer(output)
      ? output.toString("utf8")
      : "";
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const result = await fetch(`${hostApiUrl}/api/health`);
      if (result.ok) {
        return;
      }
      lastError = `${result.status} ${await result.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`API did not become healthy at ${hostApiUrl}.\n${lastError}`);
}

function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const [zipPath, content] of Object.entries(entries)) {
    zippable[zipPath] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zippable, { level: 6 });
}

async function readPublicShare(
  slug: string
): Promise<{ data: { share: Share & { content: string } } }> {
  const response = await fetch(`${hostApiUrl}/api/shares/public/${encodeURIComponent(slug)}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Public share read failed with ${response.status}.\n${text}`);
  }

  return JSON.parse(text) as { data: { share: Share & { content: string } } };
}

async function main(): Promise<void> {
  const username = `cli-${suffix}`;
  const password = `cli-password-${suffix}`;
  let userId = "";
  let firstCommitSha = "";
  let share: Share | undefined;

  await mkdir(workRoot, { recursive: true });
  await step("pack and install cli package", installCliPackage);
  await step("wait for real API health", waitForHealth);

  await step("help and health", async () => {
    const help = await runNotes(["help"]);
    assert(help.stdout.includes("notes health"), "Help output should include health command.");
    assert(
      help.stdout.includes("notes config set-api-url"),
      "Help output should include config command."
    );
    const configPath = path.join(workRoot, "configured-api-url.json");
    await runJson<{ data: { apiUrl: string } }>(["config", "set-api-url", apiUrl], {
      configPath
    });
    const configured = await runJson<{
      data: {
        apiUrl: string;
        apiUrlSource: string;
        configuredApiUrl: string | null;
        configPath: string;
        tokenConfigured: boolean;
      };
    }>(["config", "get"], { configPath });
    assertEqual(configured.data.apiUrl, apiUrl, "Configured API URL");
    assertEqual(configured.data.apiUrlSource, "env", "Configured API URL source");
    assertEqual(configured.data.configuredApiUrl, apiUrl, "Configured API URL value");
    assertEqual(configured.data.configPath, configPath, "Configured path");
    assertEqual(configured.data.tokenConfigured, false, "Configured token state");
    const configuredWithoutEnv = await runNotes(["config", "get", "--json"], {
      configPath,
      env: { NOTES_API_URL: "" }
    });
    const configuredWithoutEnvJson = JSON.parse(configuredWithoutEnv.stdout) as {
      data: { apiUrl: string; apiUrlSource: string };
    };
    assertEqual(
      configuredWithoutEnvJson.data.apiUrl,
      apiUrl,
      "Empty env should not override config"
    );
    assertEqual(configuredWithoutEnvJson.data.apiUrlSource, "config", "Empty env API URL source");
    const healthViaConfig = await runJson<{ data: { status: string; database: string } }>(
      ["health"],
      {
        configPath
      }
    );
    assertEqual(healthViaConfig.data.status, "ok", "Health via configured API URL status");
    const invalidConfig = await runNotes(["config", "set-api-url", "localhost:8080", "--json"], {
      configPath: path.join(workRoot, "invalid-config.json"),
      expectFailure: true
    });
    assert(
      invalidConfig.stderr.includes("API URL must use http or https"),
      "Invalid API URL should fail."
    );
    const healthViaFlag = await runJson<{ data: { status: string; database: string } }>(
      ["health", "--api-url", apiUrl],
      {
        configPath: userConfigPath
      }
    );
    assertEqual(healthViaFlag.data.status, "ok", "Health via --api-url status");
    const health = await runJson<{ data: { status: string; database: string } }>(["health"], {
      configPath: userConfigPath
    });
    assertEqual(health.data.status, "ok", "Health status");
    assertEqual(health.data.database, "ok", "Health database");
    const unknown = await runNotes(["unknown", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(unknown.stderr.includes("Unknown command"), "Unknown command should fail clearly.");
  });

  await step("admin login", async () => {
    const login = await runJson<{ data: { token: string; user: PublicUser } }>(
      ["auth", "login", adminUsername, adminPassword],
      { configPath: adminConfigPath }
    );
    assertEqual(login.data.user.role, "admin", "Admin role");
  });

  await step("register pending user and activate", async () => {
    const registered = await runJson<{ data: { user: PublicUser } }>(
      ["auth", "register", username, password],
      { configPath: userConfigPath }
    );
    userId = registered.data.user.id;
    assertEqual(registered.data.user.status, "pending", "Registered status");
    const duplicate = await runNotes(["auth", "register", username, password, "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(duplicate.stderr.includes("USER_ALREADY_EXISTS"), "Duplicate user should fail.");
    const invalidLogin = await runNotes(
      ["auth", "login", username, `${password}-wrong`, "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(
      invalidLogin.stderr.includes("INVALID_CREDENTIALS"),
      "Invalid password should fail with INVALID_CREDENTIALS."
    );
    const pendingLogin = await runNotes(["auth", "login", username, password, "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(
      pendingLogin.stderr.includes("USER_PENDING"),
      "Pending login should fail with USER_PENDING."
    );
    const pending = await runJson<{ data: { users: PublicUser[] } }>(["admin", "pending-users"], {
      configPath: adminConfigPath
    });
    assert(
      pending.data.users.some((user) => user.username === username),
      "Pending users should include CLI user."
    );
    const forbiddenPending = await runNotes(["admin", "pending-users", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(
      forbiddenPending.stderr.includes("Authentication token is required") ||
        forbiddenPending.stderr.includes("FORBIDDEN"),
      "Non-admin pending user listing should fail."
    );
    const missingActivation = await runNotes(
      ["admin", "activate", "00000000-0000-0000-0000-000000000000", "--json"],
      {
        configPath: adminConfigPath,
        expectFailure: true
      }
    );
    assert(
      missingActivation.stderr.includes("USER_NOT_FOUND"),
      "Missing activation target should fail."
    );
    const activated = await runJson<{ data: { user: PublicUser } }>(["admin", "activate", userId], {
      configPath: adminConfigPath
    });
    assertEqual(activated.data.user.status, "active", "Activated user status");
  });

  await step("login me logout token invalidation", async () => {
    const login = await runJson<{ data: { user: PublicUser } }>(
      ["auth", "login", username, password],
      { configPath: userConfigPath }
    );
    assertEqual(login.data.user.username, username, "Logged-in username");
    const me = await runJson<{ data: { user: PublicUser } }>(["auth", "me"], {
      configPath: userConfigPath
    });
    assertEqual(me.data.user.username, username, "Current user");
    await runJson<{ data: { ok: true } }>(["auth", "logout"], { configPath: userConfigPath });
    const afterLogout = await runNotes(["auth", "me", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(afterLogout.exitCode !== 0, "auth me after logout should fail.");
    assert(
      afterLogout.stderr.includes("Authentication token is required") ||
        afterLogout.stderr.includes("UNAUTHENTICATED"),
      "auth me after logout should report missing or invalid authentication."
    );
    await runJson(["auth", "login", username, password], { configPath: userConfigPath });
  });

  await step("folder note tree and move/delete commands", async () => {
    const unauthenticatedList = await runNotes(["folder", "ls", "/", "--json"], {
      configPath: path.join(workRoot, "empty-config.json"),
      expectFailure: true
    });
    assert(
      unauthenticatedList.stderr.includes("Authentication token is required"),
      "Unauthenticated folder ls should fail before request."
    );
    const invalidFolderPath = await runNotes(["folder", "mkdir", "relative", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(invalidFolderPath.stderr.includes("PATH_INVALID"), "Relative folder path should fail.");
    const folder = await runJson<{ data: { folder: { path: string } } }>(
      ["folder", "mkdir", "/notes"],
      {
        configPath: userConfigPath
      }
    );
    assertEqual(folder.data.folder.path, "/notes", "Created folder path");
    const duplicateFolder = await runNotes(["folder", "mkdir", "/notes", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(duplicateFolder.stderr.includes("PATH_ALREADY_EXISTS"), "Duplicate folder should fail.");
    await runJson(["folder", "mkdir", "/archive"], { configPath: userConfigPath });
    const movedFolder = await runJson<{ data: { folder: { path: string } } }>(
      ["folder", "mv", "/archive", "/notes/archive"],
      { configPath: userConfigPath }
    );
    assertEqual(movedFolder.data.folder.path, "/notes/archive", "Moved folder path");
    const markdownContent =
      '# Intro\n\nAction Item with `$HOME`, `$(command)`, \'single\' and "double" quotes.\n\n```bash\necho \\"$HOME\\"\n```\nclosing\n';
    const created = await runJson<{ data: { note: { path: string; content: string } } }>(
      ["note", "create", "/notes/a.md"],
      { configPath: userConfigPath, input: markdownContent }
    );
    assertEqual(created.data.note.path, "/notes/a.md", "Created note path");
    assertEqual(created.data.note.content, markdownContent, "Created note stdin content");
    const duplicateNote = await runNotes(["note", "create", "/notes/a.md", "--json"], {
      configPath: userConfigPath,
      expectFailure: true,
      input: "duplicate"
    });
    assert(duplicateNote.stderr.includes("PATH_ALREADY_EXISTS"), "Duplicate note should fail.");
    const invalidNotePath = await runNotes(["note", "create", "/notes/plain.txt", "--json"], {
      configPath: userConfigPath,
      expectFailure: true,
      input: "plain"
    });
    assert(invalidNotePath.stderr.includes("PATH_INVALID"), "Non-Markdown note should fail.");
    const read = await runJson<{ data: { note: { content: string } } }>(
      ["note", "read", "/notes/a.md"],
      {
        configPath: userConfigPath
      }
    );
    assertEqual(
      read.data.note.content,
      markdownContent,
      "Read note should preserve stdin content."
    );
    const replaced = await runJson<{ data: { note: { content: string } } }>(
      ["note", "replace", "/notes/a.md"],
      { configPath: userConfigPath, input: "# A\nAction Item\nclosing\n" }
    );
    assertEqual(replaced.data.note.content, "# A\nAction Item\nclosing\n", "Replaced note content");
    const grepForEdit = await runJson<{
      data: { matches: { path: string; lineNumber: number }[] };
    }>(["search", "grep", "Action Item"], { configPath: userConfigPath });
    assertEqual(grepForEdit.data.matches[0]?.lineNumber, 2, "Grep should find editable line");
    const readForEdit = await runJson<{ data: { note: { content: string } } }>(
      ["search", "read", "/notes/a.md", "--offset", "1", "--limit", "3"],
      { configPath: userConfigPath }
    );
    assert(
      readForEdit.data.note.content.includes("Action Item"),
      "Read slice should include target."
    );
    const edited = await runJson<{ data: { note: { content: string } } }>(
      ["note", "edit", "/notes/a.md", "--from-line", "2", "--to-line", "2"],
      { configPath: userConfigPath, input: "First action\nSecond action" }
    );
    assertEqual(
      edited.data.note.content,
      "# A\nFirst action\nSecond action\nclosing\n",
      "Edited note content"
    );
    const deletedLines = await runJson<{ data: { note: { content: string } } }>(
      ["note", "edit", "/notes/a.md", "--from-line", "2", "--to-line", "3"],
      { configPath: userConfigPath, input: "" }
    );
    assertEqual(deletedLines.data.note.content, "# A\nclosing\n", "Deleted note line range");
    const staleEdit = await runNotes(
      [
        "note",
        "edit",
        "/notes/a.md",
        "--from-line",
        "1",
        "--to-line",
        "1",
        "--if-match",
        "stale-version",
        "--json"
      ],
      {
        configPath: userConfigPath,
        expectFailure: true,
        input: "# Stale"
      }
    );
    assert(staleEdit.stderr.includes("EDIT_CONFLICT"), "Stale edit should fail.");
    await runJson(["note", "replace", "/notes/a.md"], {
      configPath: userConfigPath,
      input: "# A\nAction Item\nclosing\n"
    });
    const stdinCreated = await runJson<{ data: { note: { path: string; content: string } } }>(
      ["note", "create", "/notes/from-stdin.md"],
      { configPath: userConfigPath, input: "# A\nAction Item\nclosing\n" }
    );
    assertEqual(
      stdinCreated.data.note.content,
      "# A\nAction Item\nclosing\n",
      "Stdin note content"
    );
    await runJson(["note", "rm", "/notes/from-stdin.md"], { configPath: userConfigPath });
    const staleReplace = await runNotes(
      ["note", "replace", "/notes/a.md", "--if-match", "stale-version", "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true,
        input: "# Stale\n"
      }
    );
    assert(staleReplace.stderr.includes("EDIT_CONFLICT"), "Stale replace should fail.");
    await runJson(["note", "create", "/notes/temp.md"], {
      configPath: userConfigPath,
      input: "temporary\n"
    });
    const moved = await runJson<{ data: { note: { path: string } } }>(
      ["note", "mv", "/notes/temp.md", "/notes/moved.md"],
      { configPath: userConfigPath }
    );
    assertEqual(moved.data.note.path, "/notes/moved.md", "Moved note path");
    const missingMove = await runNotes(
      ["note", "mv", "/notes/nope.md", "/notes/nope-moved.md", "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(missingMove.stderr.includes("PATH_NOT_FOUND"), "Missing note move should fail.");
    await runJson(["note", "rm", "/notes/moved.md"], { configPath: userConfigPath });
    const missingDelete = await runNotes(["note", "rm", "/notes/moved.md", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(missingDelete.stderr.includes("PATH_NOT_FOUND"), "Missing note delete should fail.");
    const folderSelfMove = await runNotes(["folder", "mv", "/notes", "/notes/nested", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(folderSelfMove.stderr.includes("PATH_INVALID"), "Folder self move should fail.");
    const list = await runJson<{ data: { entries: { path: string }[] } }>(
      ["folder", "ls", "/notes"],
      {
        configPath: userConfigPath
      }
    );
    assert(
      list.data.entries.some((entry) => entry.path === "/notes/a.md"),
      "Folder ls should include /notes/a.md."
    );
    const tree = await runJson<{ data: { tree: { children?: { path: string }[] } } }>(["tree"], {
      configPath: userConfigPath
    });
    assert(
      tree.data.tree.children?.some((entry) => entry.path === "/notes"),
      "Tree should include /notes."
    );
  });

  await step("status diff commit history discard restore", async () => {
    const status = await runJson<{ data: { changes: { path: string }[] } }>(["status"], {
      configPath: userConfigPath
    });
    assert(
      status.data.changes.some((change) => change.path === "/notes/a.md"),
      "Status should include /notes/a.md."
    );
    await runJson(["note", "create", "/notes/开发习惯.md"], {
      configPath: userConfigPath,
      input: "# 开发习惯\n"
    });
    const unicodeStatus = await runJson<{ data: { changes: { path: string }[] } }>(["status"], {
      configPath: userConfigPath
    });
    assert(
      unicodeStatus.data.changes.some((change) => change.path === "/notes/开发习惯.md"),
      "Status should preserve non-ASCII note paths."
    );
    const diff = await runJson<{ data: { diff: string } }>(["diff"], {
      configPath: userConfigPath
    });
    assert(diff.data.diff.includes("+# A"), "Diff should include added note.");
    assert(
      diff.data.diff.includes("notes/开发习惯.md"),
      "Diff should preserve non-ASCII note paths."
    );
    const missingMessage = await runNotes(["commit", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(
      missingMessage.stderr.includes("Commit message is required"),
      "Commit without message should fail."
    );
    const commitResult = await runJson<{ data: { commit: { sha: string; message: string } } }>(
      ["commit", "-m", "cli full initial"],
      { configPath: userConfigPath }
    );
    firstCommitSha = commitResult.data.commit.sha;
    assert(/^[0-9a-f]{40}$/.test(firstCommitSha), "Commit sha should be valid.");
    const history = await runJson<{ data: { commits: { message: string }[] } }>(["history"], {
      configPath: userConfigPath
    });
    assertEqual(history.data.commits[0]?.message, "cli full initial", "Latest history message");
    const show = await runJson<{
      data: { show: { commit: { sha: string; message: string }; diff: string } };
    }>(["show", firstCommitSha], {
      configPath: userConfigPath
    });
    assertEqual(show.data.show.commit.sha, firstCommitSha, "Show commit sha");
    assertEqual(show.data.show.commit.message, "cli full initial", "Show commit message");
    assert(show.data.show.diff.includes("+# A"), "Show diff should include added note.");
    assert(
      show.data.show.diff.includes("notes/开发习惯.md"),
      "Show diff should preserve non-ASCII note paths."
    );
    const humanShow = await runNotes(["show", firstCommitSha], {
      configPath: userConfigPath
    });
    assert(humanShow.stdout.includes(`commit ${firstCommitSha}`), "Human show should include sha.");
    assert(humanShow.stdout.includes("cli full initial"), "Human show should include message.");
    const invalidShowSha = await runNotes(["show", "not-a-sha", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(invalidShowSha.stderr.includes("VALIDATION_ERROR"), "Invalid show sha should fail.");
    const emptyCommit = await runNotes(["commit", "-m", "empty", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(emptyCommit.stderr.includes("NO_CHANGES_TO_COMMIT"), "Empty commit should fail.");
    const invalidRestoreSha = await runNotes(
      ["restore", "--commit", "not-a-sha", "--path", "/notes/a.md", "--type", "file", "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(
      invalidRestoreSha.stderr.includes("VALIDATION_ERROR"),
      "Invalid restore sha should fail."
    );
    await runJson(["note", "replace", "/notes/a.md"], {
      configPath: userConfigPath,
      input: "# Draft\nAction Item\nclosing\n"
    });
    const draftDiff = await runJson<{ data: { diff: string } }>(["diff"], {
      configPath: userConfigPath
    });
    assert(draftDiff.data.diff.includes("+# Draft"), "Draft diff should include new heading.");
    await runJson(["discard"], { configPath: userConfigPath });
    const afterDiscard = await runJson<{ data: { note: { content: string } } }>(
      ["note", "read", "/notes/a.md"],
      {
        configPath: userConfigPath
      }
    );
    assertEqual(
      afterDiscard.data.note.content,
      "# A\nAction Item\nclosing\n",
      "Discarded note content"
    );
    await runJson(["note", "replace", "/notes/a.md"], {
      configPath: userConfigPath,
      input: "# Second\nAction Item\nclosing\n"
    });
    await runJson(["folder", "rm", "/notes/archive"], { configPath: userConfigPath });
    await runJson(["commit", "-m", "cli full second"], { configPath: userConfigPath });
    const restored = await runJson<{ data: { restored: { path: string; type: string } } }>(
      ["restore", "--commit", firstCommitSha, "--path", "/notes/a.md", "--type", "file"],
      { configPath: userConfigPath }
    );
    assertEqual(restored.data.restored.path, "/notes/a.md", "Restored path");
    const mismatchedRestore = await runNotes(
      [
        "restore",
        "--commit",
        firstCommitSha,
        "--path",
        "/notes/a.md",
        "--type",
        "folder",
        "--json"
      ],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(mismatchedRestore.stderr.includes("PATH_INVALID"), "Wrong restore type should fail.");
    await runJson(["discard"], { configPath: userConfigPath });
    await runJson(["restore", "--commit", firstCommitSha, "--path", "/notes", "--type", "folder"], {
      configPath: userConfigPath
    });
  });

  await step("search glob grep read", async () => {
    const invalidGlob = await runNotes(["search", "glob", "../**/*", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(invalidGlob.stderr.includes("GLOB_INVALID"), "Invalid glob should fail.");
    const glob = await runJson<{ data: { matches: { path: string }[] } }>(
      ["search", "glob", "**/*"],
      {
        configPath: userConfigPath
      }
    );
    assert(
      glob.data.matches.some((match) => match.path === "/notes/a.md"),
      "Glob should find /notes/a.md."
    );
    const grep = await runJson<{ data: { matches: { path: string; line: string }[] } }>(
      ["search", "grep", "action item", "--ignore-case", "--glob", "notes/**/*.md"],
      { configPath: userConfigPath }
    );
    assertEqual(grep.data.matches[0]?.line, "Action Item", "Grep match line");
    const regex = await runJson<{ data: { matches: { path: string; line: string }[] } }>(
      ["search", "grep", "Action\\s+Item", "--regex"],
      { configPath: userConfigPath }
    );
    assertEqual(regex.data.matches.length, 1, "Regex grep match count");
    const invalidRegex = await runNotes(["search", "grep", "[", "--regex", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(invalidRegex.stderr.includes("REGEX_INVALID"), "Invalid regex should fail.");
    const read = await runJson<{ data: { note: { content: string } } }>(
      ["search", "read", "/notes/a.md", "--offset", "2", "--limit", "1"],
      { configPath: userConfigPath }
    );
    assertEqual(read.data.note.content, "Action Item", "Search read content");
    const invalidReadLimit = await runNotes(
      ["search", "read", "/notes/a.md", "--offset", "0", "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(
      invalidReadLimit.stderr.includes("VALIDATION_ERROR"),
      "Invalid read offset should fail."
    );
  });

  await step("export import dry-run import", async () => {
    const exportPath = path.join(workRoot, "export.zip");
    await runJson<{ data: { path: string } }>(["export", "-o", `${commandWorkRoot}/export.zip`], {
      configPath: userConfigPath
    });
    assert(await fileExists(exportPath), "Export file should exist on host.");
    const conflictZip = makeZip({ "notes/a.md": "# Conflict\n" });
    await writeFile(path.join(workRoot, "conflict.zip"), conflictZip);
    const conflict = await runJson<{ data: { plan: { conflicts: { path: string }[] } } }>(
      ["import", `${commandWorkRoot}/conflict.zip`, "--dry-run"],
      { configPath: userConfigPath }
    );
    assertEqual(conflict.data.plan.conflicts[0]?.path, "/notes/a.md", "Import conflict path");
    const conflictImport = await runNotes(["import", `${commandWorkRoot}/conflict.zip`, "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(conflictImport.stderr.includes("IMPORT_CONFLICT"), "Conflict import should fail.");
    await writeFile(path.join(workRoot, "invalid.zip"), "not a zip", "utf8");
    const invalidZip = await runNotes(
      ["import", `${commandWorkRoot}/invalid.zip`, "--dry-run", "--json"],
      {
        configPath: userConfigPath,
        expectFailure: true
      }
    );
    assert(invalidZip.stderr.includes("VALIDATION_ERROR"), "Invalid zip should fail.");
    const unsupportedZip = makeZip({
      "imported/not-markdown.txt": "Nope\n"
    });
    await writeFile(path.join(workRoot, "unsupported.zip"), unsupportedZip);
    const unsupported = await runJson<{ data: { plan: { conflicts: { path: string }[] } } }>(
      ["import", `${commandWorkRoot}/unsupported.zip`, "--dry-run"],
      { configPath: userConfigPath }
    );
    assertEqual(
      unsupported.data.plan.conflicts[0]?.path,
      "/imported/not-markdown.txt",
      "Unsupported import conflict path"
    );
    const importZip = makeZip({
      "imported/": new Uint8Array(0),
      "imported/empty/": new Uint8Array(0),
      "imported/cli.md": "# Imported by CLI\n"
    });
    await writeFile(path.join(workRoot, "import.zip"), importZip);
    const dryRun = await runJson<{ data: { plan: { files: string[]; conflicts: unknown[] } } }>(
      ["import", `${commandWorkRoot}/import.zip`, "--dry-run"],
      { configPath: userConfigPath }
    );
    assert(
      dryRun.data.plan.files.includes("/imported/cli.md"),
      "Dry run should include imported file."
    );
    assertEqual(dryRun.data.plan.conflicts.length, 0, "Dry-run conflicts");
    await runJson(["import", `${commandWorkRoot}/import.zip`], { configPath: userConfigPath });
    const imported = await runJson<{ data: { note: { content: string } } }>(
      ["note", "read", "/imported/cli.md"],
      { configPath: userConfigPath }
    );
    assertEqual(imported.data.note.content, "# Imported by CLI\n", "Imported CLI note content");
  });

  await step("share publish list public read unpublish", async () => {
    await runJson(["note", "create", "/public.md"], {
      configPath: userConfigPath,
      input: "# CLI Public\n"
    });
    const uncommittedPublish = await runNotes(["share", "publish", "/public.md", "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(
      uncommittedPublish.stderr.includes("NOTE_NOT_COMMITTED"),
      "Uncommitted publish should fail."
    );
    await runJson(["commit", "-m", "cli full publishable"], { configPath: userConfigPath });
    const published = await runJson<{ data: { share: Share } }>(
      ["share", "publish", "/public.md"],
      {
        configPath: userConfigPath
      }
    );
    share = published.data.share;
    assertEqual(share.notePath, "/public.md", "Published note path");
    const publicShare = await readPublicShare(share.slug);
    assertEqual(publicShare.data.share.content, "# CLI Public\n", "Public share content");
    const shares = await runJson<{ data: { shares: Share[] } }>(["share", "list"], {
      configPath: userConfigPath
    });
    assert(
      shares.data.shares.some((candidate) => candidate.id === share?.id),
      "Share list should include published share."
    );
    await runJson(["share", "unpublish", share.id], { configPath: userConfigPath });
    const duplicateUnpublish = await runNotes(["share", "unpublish", share.id, "--json"], {
      configPath: userConfigPath,
      expectFailure: true
    });
    assert(
      duplicateUnpublish.stderr.includes("SHARE_NOT_FOUND"),
      "Duplicate unpublish should fail."
    );
    const missingShare = await fetch(
      `${hostApiUrl}/api/shares/public/${encodeURIComponent(share.slug)}`
    );
    assertEqual(missingShare.status, 404, "Unpublished share status");
  });

  await rm(workRoot, { recursive: true, force: true });
  process.stdout.write(`[cli-full] passed for ${username}\n`);
}

async function installCliPackage(): Promise<void> {
  await mkdir(cliPackRoot, { recursive: true });
  await mkdir(cliInstallRoot, { recursive: true });
  await writeFile(
    path.join(cliInstallRoot, "package.json"),
    JSON.stringify({ private: true }, null, 2),
    "utf8"
  );

  const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", cliPackRoot], {
    cwd: cliPackageRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000
  });
  const tarballName = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  assert(tarballName, `npm pack did not return a package tarball.\n${stdout}`);

  const tarballPath = path.join(cliPackRoot, tarballName);
  await execFileAsync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: cliInstallRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000
  });

  notesCommand = cliBinPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(filePath));
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { apiSuccess } from "../shared/api";
import { makeAuthenticate, requireCurrentUser } from "./auth";
import type { UserRole } from "./auth";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import {
  assertCanAddMarkdownNotes,
  ensureUserGitWorkspace,
  normalizeApiPath,
  readEmptyFolderPaths,
  removeEmptyFolderPath,
  resolveWorkspacePath,
  type WorkspacePath,
  writeEmptyFolderPaths,
  WorkspaceError
} from "./workspace";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 20 * 1024 * 1024;
const gitGlobalOptions = ["-c", "core.quotepath=false"];
const protectedPathSegments = new Set([".git", ".notes-meta"]);

type CommitBody = {
  message?: unknown;
};

type ShowQuery = {
  commit?: unknown;
  commitSha?: unknown;
};

type RestoreBody = {
  commit?: unknown;
  commitSha?: unknown;
  path?: unknown;
  type?: unknown;
};

type GitStatusChange = {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  indexStatus: string;
  worktreeStatus: string;
  oldPath?: string;
};

type RestoreType = "file" | "folder";

export function registerVersionRoutes(app: FastifyInstance, config: AppConfig, db: Database): void {
  const authenticate = makeAuthenticate(config, db);

  app.get(
    "/api/version/status",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      return apiSuccess({
        changes: await getGitStatusChanges(userWorkspacePath)
      });
    }
  );

  app.get(
    "/api/version/diff",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      return apiSuccess({
        diff: await getGitDiff(userWorkspacePath)
      });
    }
  );

  app.post<{ Body: CommitBody }>(
    "/api/version/commit",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const message = readCommitMessage(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      await runGit(userWorkspacePath, ["add", "-A"]);

      const changes = await getGitStatusChanges(userWorkspacePath);
      if (changes.length === 0) {
        throw new WorkspaceError("NO_CHANGES_TO_COMMIT", "No changes to commit.", 409);
      }

      await runGit(userWorkspacePath, [
        "-c",
        "user.name=Cloud Markdown Notes",
        "-c",
        "user.email=notes@example.invalid",
        "commit",
        "-m",
        message
      ]);
      const sha = (await runGit(userWorkspacePath, ["rev-parse", "HEAD"])).trim();

      return apiSuccess({
        commit: {
          sha,
          message
        }
      });
    }
  );

  app.get(
    "/api/version/history",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      return apiSuccess({
        commits: await getGitHistory(userWorkspacePath)
      });
    }
  );

  app.get<{ Querystring: ShowQuery }>(
    "/api/version/show",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const requestedCommitSha = readCommitSha(request.query);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const commitSha = await resolveCommitSha(userWorkspacePath, requestedCommitSha);

      return apiSuccess({
        show: await getGitCommitDetail(userWorkspacePath, commitSha)
      });
    }
  );

  app.post(
    "/api/version/discard",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      if (await hasHeadCommit(userWorkspacePath)) {
        await runGit(userWorkspacePath, ["reset", "--hard", "HEAD"]);
      }
      await runGit(userWorkspacePath, ["clean", "-fd"]);

      return apiSuccess({
        ok: true
      });
    }
  );

  app.post<{ Body: RestoreBody }>(
    "/api/version/restore",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const restoreRequest = readRestoreBody(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const commitSha = await resolveCommitSha(userWorkspacePath, restoreRequest.commitSha);
      const restored = await restoreFromHistory(
        userWorkspacePath,
        user.role,
        commitSha,
        restoreRequest.path,
        restoreRequest.type
      );

      return apiSuccess({
        restored
      });
    }
  );
}

async function getGitStatusChanges(userWorkspacePath: string): Promise<GitStatusChange[]> {
  const output = await runGit(userWorkspacePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z"
  ]);

  return parseGitStatusOutput(output);
}

async function getGitDiff(userWorkspacePath: string): Promise<string> {
  const parts: string[] = [];
  const cachedDiff = await runGit(userWorkspacePath, ["diff", "--cached", "--"]);
  const workingTreeDiff = await runGit(userWorkspacePath, ["diff", "--"]);

  if (cachedDiff) {
    parts.push(cachedDiff.trimEnd());
  }

  if (workingTreeDiff) {
    parts.push(workingTreeDiff.trimEnd());
  }

  for (const filePath of await listUntrackedFiles(userWorkspacePath)) {
    const untrackedDiff = await runGit(
      userWorkspacePath,
      ["diff", "--no-index", "--", "/dev/null", filePath],
      [0, 1]
    );
    if (untrackedDiff) {
      parts.push(untrackedDiff.trimEnd());
    }
  }

  return parts.join("\n");
}

async function listUntrackedFiles(userWorkspacePath: string): Promise<string[]> {
  const output = await runGit(userWorkspacePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);

  return output.split("\0").filter(Boolean);
}

async function getGitHistory(userWorkspacePath: string) {
  if (!(await hasHeadCommit(userWorkspacePath))) {
    return [];
  }

  const output = await runGit(userWorkspacePath, [
    "log",
    "--date=iso-strict",
    "--pretty=format:%H%x00%cI%x00%s%x1e"
  ]);

  return output
    .split("\x1e")
    .map((record) => record.trimStart())
    .filter(Boolean)
    .map((record) => {
      const [sha, committedAt, message] = record.split("\0");
      return {
        sha,
        message,
        committedAt
      };
    });
}

async function getGitCommitDetail(userWorkspacePath: string, commitSha: string) {
  const [metadata, diff] = await Promise.all([
    runGit(userWorkspacePath, [
      "show",
      "--no-patch",
      "--date=iso-strict",
      "--pretty=format:%H%x00%cI%x00%s",
      commitSha
    ]),
    runGit(userWorkspacePath, ["show", "--format=", "--patch", "--find-renames", commitSha])
  ]);
  const [sha, committedAt, message] = metadata.split("\0");

  return {
    commit: {
      sha,
      message,
      committedAt
    },
    diff: diff.trimEnd()
  };
}

async function restoreFromHistory(
  userWorkspacePath: string,
  userRole: UserRole,
  commitSha: string,
  apiPath: string,
  requestedType?: RestoreType
) {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  const commitEmptyFolderPaths = await readEmptyFolderPathsFromCommit(userWorkspacePath, commitSha);
  const objectType = await getCommitObjectType(
    userWorkspacePath,
    commitSha,
    workspacePath.relativePath
  );
  const metadataHasFolder = commitEmptyFolderPaths.some((folderPath) =>
    isApiPathWithin(folderPath, workspacePath.apiPath)
  );
  const inferredType = inferRestoreType(objectType, metadataHasFolder);

  if (!inferredType) {
    throw new WorkspaceError("PATH_NOT_FOUND", "Path not found in commit.", 404);
  }

  if (requestedType && requestedType !== inferredType) {
    throw new WorkspaceError("PATH_INVALID", "Restore type does not match the committed path.");
  }

  if (inferredType === "file") {
    await restoreFileFromHistory(userWorkspacePath, userRole, commitSha, workspacePath);
  } else {
    await restoreFolderFromHistory(
      userWorkspacePath,
      userRole,
      commitSha,
      workspacePath,
      objectType === "tree",
      commitEmptyFolderPaths
    );
  }

  return {
    path: workspacePath.apiPath,
    type: inferredType,
    commitSha
  };
}

async function restoreFileFromHistory(
  userWorkspacePath: string,
  userRole: UserRole,
  commitSha: string,
  workspacePath: WorkspacePath
): Promise<void> {
  if (!workspacePath.relativePath) {
    throw new WorkspaceError("PATH_INVALID", "Root cannot be restored as a file.");
  }

  const restoredNoteCount = workspacePath.apiPath.endsWith(".md") ? 1 : 0;
  const currentNoteCount = await countMarkdownNotesAtPath(workspacePath.absolutePath);
  await assertCanAddMarkdownNotes(
    userRole,
    userWorkspacePath,
    Math.max(0, restoredNoteCount - currentNoteCount)
  );

  const content = await runGit(userWorkspacePath, [
    "show",
    `${commitSha}:${workspacePath.relativePath}`
  ]);

  await rm(workspacePath.absolutePath, { recursive: true, force: true });
  await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
  await writeFile(workspacePath.absolutePath, content, "utf8");
  await removeEmptyFolderPath(userWorkspacePath, workspacePath.apiPath, {
    includeChildren: true
  });
  await removeEmptyFolderPath(userWorkspacePath, getParentApiPath(workspacePath.apiPath));
}

async function restoreFolderFromHistory(
  userWorkspacePath: string,
  userRole: UserRole,
  commitSha: string,
  workspacePath: WorkspacePath,
  hasCommittedTree: boolean,
  commitEmptyFolderPaths: string[]
): Promise<void> {
  const files = hasCommittedTree
    ? (await listFilesInCommit(userWorkspacePath, commitSha, workspacePath.relativePath)).filter(
        (filePath) => !hasProtectedPathSegment(filePath)
      )
    : [];
  const restoredNoteCount = files.filter((filePath) => filePath.endsWith(".md")).length;
  const currentNoteCount = await countMarkdownNotesAtPath(workspacePath.absolutePath);
  await assertCanAddMarkdownNotes(
    userRole,
    userWorkspacePath,
    Math.max(0, restoredNoteCount - currentNoteCount)
  );

  await clearWorkspacePath(userWorkspacePath, workspacePath);

  for (const filePath of files) {
    const absolutePath = path.join(userWorkspacePath, ...filePath.split("/"));
    const content = await runGit(userWorkspacePath, ["show", `${commitSha}:${filePath}`]);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  await restoreEmptyFolderMetadata(
    userWorkspacePath,
    workspacePath.apiPath,
    commitEmptyFolderPaths
  );
}

async function restoreEmptyFolderMetadata(
  userWorkspacePath: string,
  restoredApiPath: string,
  commitEmptyFolderPaths: string[]
): Promise<void> {
  const currentEmptyFolderPaths = await readEmptyFolderPaths(userWorkspacePath);
  const restoredEmptyFolderPaths = commitEmptyFolderPaths.filter((folderPath) =>
    isApiPathWithin(folderPath, restoredApiPath)
  );
  const nextEmptyFolderPaths = [
    ...currentEmptyFolderPaths.filter(
      (folderPath) => !isApiPathWithin(folderPath, restoredApiPath)
    ),
    ...restoredEmptyFolderPaths
  ];

  await writeEmptyFolderPaths(userWorkspacePath, nextEmptyFolderPaths);

  for (const folderPath of restoredEmptyFolderPaths) {
    const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
    await mkdir(workspacePath.absolutePath, { recursive: true });
  }
}

async function readEmptyFolderPathsFromCommit(
  userWorkspacePath: string,
  commitSha: string
): Promise<string[]> {
  let raw: string;
  try {
    raw = await runGit(userWorkspacePath, ["show", `${commitSha}:.notes-meta/folders.json`]);
  } catch {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new WorkspaceError("PATH_INVALID", "Invalid folder metadata in commit.");
  }

  return [
    ...new Set(parsed.map((folderPath) => normalizeApiPath(folderPath)).filter((p) => p !== "/"))
  ].sort((left, right) => left.localeCompare(right));
}

async function listFilesInCommit(
  userWorkspacePath: string,
  commitSha: string,
  relativePath: string
): Promise<string[]> {
  const args = relativePath
    ? ["ls-tree", "-r", "-z", "--name-only", commitSha, "--", relativePath]
    : ["ls-tree", "-r", "-z", "--name-only", commitSha];
  const output = await runGit(userWorkspacePath, args);

  return output.split("\0").filter(Boolean);
}

async function getCommitObjectType(
  userWorkspacePath: string,
  commitSha: string,
  relativePath: string
): Promise<"blob" | "tree" | undefined> {
  if (!relativePath) {
    return "tree";
  }

  try {
    const output = await runGit(userWorkspacePath, [
      "cat-file",
      "-t",
      `${commitSha}:${relativePath}`
    ]);
    const objectType = output.trim();
    return objectType === "blob" || objectType === "tree" ? objectType : undefined;
  } catch {
    return undefined;
  }
}

async function resolveCommitSha(userWorkspacePath: string, commitSha: string): Promise<string> {
  if (!/^[0-9a-fA-F]{7,40}$/.test(commitSha)) {
    throw new WorkspaceError("VALIDATION_ERROR", "A valid commit sha is required.");
  }

  try {
    return (
      await runGit(userWorkspacePath, ["rev-parse", "--verify", `${commitSha}^{commit}`])
    ).trim();
  } catch {
    throw new WorkspaceError("PATH_NOT_FOUND", "Commit not found.", 404);
  }
}

async function hasHeadCommit(userWorkspacePath: string): Promise<boolean> {
  try {
    await runGit(userWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function clearWorkspacePath(
  userWorkspacePath: string,
  workspacePath: WorkspacePath
): Promise<void> {
  if (workspacePath.apiPath !== "/") {
    await rm(workspacePath.absolutePath, { recursive: true, force: true });
    return;
  }

  const entries = await readdir(userWorkspacePath, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) =>
        rm(path.join(userWorkspacePath, entry.name), { recursive: true, force: true })
      )
  );
}

async function countMarkdownNotesAtPath(absolutePath: string): Promise<number> {
  let entryStat;
  try {
    entryStat = await stat(absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return 0;
    }

    throw error;
  }

  if (entryStat.isFile()) {
    return absolutePath.endsWith(".md") ? 1 : 0;
  }

  if (!entryStat.isDirectory()) {
    return 0;
  }

  return countMarkdownNotesInDirectory(absolutePath);
}

async function countMarkdownNotesInDirectory(directoryPath: string): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (protectedPathSegments.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      count += await countMarkdownNotesInDirectory(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    }
  }

  return count;
}

function readCommitMessage(body: CommitBody | undefined): string {
  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    throw new WorkspaceError("COMMIT_MESSAGE_REQUIRED", "Commit message is required.");
  }

  return body.message.trim();
}

function readCommitSha(source: ShowQuery | undefined): string {
  const commitSha = typeof source?.commitSha === "string" ? source.commitSha : source?.commit;
  if (typeof commitSha !== "string" || !commitSha.trim()) {
    throw new WorkspaceError("VALIDATION_ERROR", "commitSha is required.");
  }

  return commitSha.trim();
}

function readRestoreBody(body: RestoreBody | undefined): {
  commitSha: string;
  path: string;
  type?: RestoreType;
} {
  const commitSha = typeof body?.commitSha === "string" ? body.commitSha : body?.commit;
  if (typeof commitSha !== "string" || !commitSha.trim()) {
    throw new WorkspaceError("VALIDATION_ERROR", "commitSha is required.");
  }

  if (typeof body?.path !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Path is required.");
  }

  if (body.type !== undefined && body.type !== "file" && body.type !== "folder") {
    throw new WorkspaceError("VALIDATION_ERROR", "Restore type must be file or folder.");
  }

  return {
    commitSha: commitSha.trim(),
    path: normalizeApiPath(body.path),
    type: body.type
  };
}

function parseGitStatusOutput(output: string): GitStatusChange[] {
  const records = output.split("\0").filter(Boolean);
  const changes: GitStatusChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const line = records[index] ?? "";
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    const rawPath = line.slice(3);

    if (indexStatus === "R" || indexStatus === "C") {
      const oldPath = records[index + 1];
      if (oldPath === undefined) {
        changes.push(parseGitStatusLine(line));
      } else {
        changes.push({
          path: gitPathToApiPath(rawPath),
          oldPath: gitPathToApiPath(oldPath),
          changeType: indexStatus === "R" ? "renamed" : "copied",
          indexStatus,
          worktreeStatus
        });
        index += 1;
      }
      continue;
    }

    changes.push(parseGitStatusLine(line));
  }

  return changes;
}

function parseGitStatusLine(line: string): GitStatusChange {
  const indexStatus = line[0] ?? " ";
  const worktreeStatus = line[1] ?? " ";
  const rawPath = line.slice(3);
  const renameSeparator = " -> ";
  const renameIndex = rawPath.indexOf(renameSeparator);

  if (renameIndex >= 0) {
    const oldPath = rawPath.slice(0, renameIndex);
    const newPath = rawPath.slice(renameIndex + renameSeparator.length);
    return {
      path: gitPathToApiPath(newPath),
      oldPath: gitPathToApiPath(oldPath),
      changeType: "renamed",
      indexStatus,
      worktreeStatus
    };
  }

  return {
    path: gitPathToApiPath(rawPath),
    changeType: statusToChangeType(indexStatus, worktreeStatus),
    indexStatus,
    worktreeStatus
  };
}

function statusToChangeType(
  indexStatus: string,
  worktreeStatus: string
): GitStatusChange["changeType"] {
  const statuses = new Set([indexStatus, worktreeStatus]);

  if (statuses.has("?")) {
    return "untracked";
  }

  if (statuses.has("R")) {
    return "renamed";
  }

  if (statuses.has("C")) {
    return "copied";
  }

  if (statuses.has("D")) {
    return "deleted";
  }

  if (statuses.has("A")) {
    return "added";
  }

  if (statuses.has("M")) {
    return "modified";
  }

  return "unknown";
}

function inferRestoreType(
  objectType: "blob" | "tree" | undefined,
  metadataHasFolder: boolean
): RestoreType | undefined {
  if (objectType === "blob") {
    return "file";
  }

  if (objectType === "tree" || metadataHasFolder) {
    return "folder";
  }

  return undefined;
}

function gitPathToApiPath(gitPath: string): string {
  const normalized = path.posix.normalize(`/${gitPath.replaceAll("\\", "/")}`);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isApiPathWithin(candidatePath: string, parentPath: string): boolean {
  return parentPath === "/"
    ? candidatePath.startsWith("/")
    : candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function hasProtectedPathSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => protectedPathSegments.has(segment));
}

function getParentApiPath(apiPath: string): string {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const parentPath = path.posix.dirname(normalizedApiPath);
  return parentPath === "." ? "/" : parentPath;
}

async function runGit(
  cwd: string,
  args: string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...gitGlobalOptions, ...args], {
      cwd,
      maxBuffer: gitMaxBuffer,
      timeout: 10000
    });
    return stdout;
  } catch (error) {
    const exitCode = getExitCode(error);
    if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
      return getProcessOutput(error, "stdout");
    }

    const stderr = getProcessOutput(error, "stderr");
    throw new Error(stderr || "Git command failed.");
  }
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

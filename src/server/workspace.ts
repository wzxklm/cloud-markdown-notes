import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ErrorCode } from "../shared/errors";

const execFileAsync = promisify(execFile);
const metadataDirectoryName = ".notes-meta";
const foldersFileName = "folders.json";
const protectedPathSegments = new Set([".git", metadataDirectoryName]);
const defaultMarkdownNoteLimit = 1000;
const metadataLocks = new Map<string, Promise<void>>();

export type WorkspaceUserRole = "admin" | "user";

export type WorkspacePath = {
  apiPath: string;
  relativePath: string;
  absolutePath: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "folder" | "note" | "file";
};

export type WorkspaceTreeEntry = WorkspaceEntry & {
  children?: WorkspaceTreeEntry[];
};

export class WorkspaceError extends Error {
  code: ErrorCode;
  statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function ensureWorkspaceRoot(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
}

export async function assertWorkspaceWritable(workspaceRoot: string): Promise<boolean> {
  await ensureWorkspaceRoot(workspaceRoot);
  const probePath = path.join(workspaceRoot, `.health-${process.pid}-${Date.now()}`);
  await writeFile(probePath, os.hostname(), "utf8");
  await access(probePath);
  await rm(probePath, { force: true });
  return true;
}

export function getUserWorkspacePath(workspaceRoot: string, userId: string): string {
  return path.join(workspaceRoot, userId);
}

export async function ensureUserGitWorkspace(
  workspaceRoot: string,
  userId: string
): Promise<string> {
  await ensureWorkspaceRoot(workspaceRoot);

  const userWorkspace = getUserWorkspacePath(workspaceRoot, userId);
  await mkdir(userWorkspace, { recursive: true });

  try {
    await access(path.join(userWorkspace, ".git"));
  } catch {
    await execFileAsync("git", ["init"], { cwd: userWorkspace });
  }

  return userWorkspace;
}

export function normalizeApiPath(apiPath: string): string {
  if (!apiPath || !apiPath.startsWith("/")) {
    throw new WorkspaceError("PATH_INVALID", "Path must start with /.");
  }

  if (apiPath.includes("\\") || apiPath.includes("\0")) {
    throw new WorkspaceError("PATH_INVALID", "Path contains invalid characters.");
  }

  const rawSegments = apiPath.split("/").filter(Boolean);
  assertAllowedPathSegments(rawSegments);

  const posixNormalized = path.posix.normalize(apiPath);
  const normalized =
    posixNormalized.length > 1 && posixNormalized.endsWith("/")
      ? posixNormalized.slice(0, -1)
      : posixNormalized;
  const normalizedSegments = normalized === "/" ? [] : normalized.slice(1).split("/");
  assertAllowedPathSegments(normalizedSegments);

  return normalized;
}

export function resolveWorkspacePath(userWorkspacePath: string, apiPath: string): WorkspacePath {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const workspaceRoot = path.resolve(userWorkspacePath);
  const segments = normalizedApiPath === "/" ? [] : normalizedApiPath.slice(1).split("/");
  const absolutePath = path.resolve(workspaceRoot, ...segments);

  if (!isPathInside(workspaceRoot, absolutePath)) {
    throw new WorkspaceError("PATH_INVALID", "Path is outside the user workspace.");
  }

  return {
    apiPath: normalizedApiPath,
    relativePath: segments.join("/"),
    absolutePath
  };
}

export function resolveUserWorkspacePath(
  workspaceRoot: string,
  userId: string,
  apiPath: string
): WorkspacePath {
  return resolveWorkspacePath(getUserWorkspacePath(workspaceRoot, userId), apiPath);
}

export async function assertWorkspacePathAvailable(
  userWorkspacePath: string,
  apiPath: string
): Promise<WorkspacePath> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);

  if (await pathExists(workspacePath.absolutePath)) {
    throw new WorkspaceError("PATH_ALREADY_EXISTS", "Path already exists.", 409);
  }

  const emptyFolderPaths = await readEmptyFolderPaths(userWorkspacePath);
  if (
    emptyFolderPaths.some(
      (folderPath) =>
        folderPath === workspacePath.apiPath || folderPath.startsWith(`${workspacePath.apiPath}/`)
    )
  ) {
    throw new WorkspaceError("PATH_ALREADY_EXISTS", "Path already exists.", 409);
  }

  return workspacePath;
}

export async function readEmptyFolderPaths(userWorkspacePath: string): Promise<string[]> {
  const filePath = getFoldersFilePath(userWorkspacePath);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new WorkspaceError("PATH_INVALID", "Invalid folder metadata.");
  }

  return normalizeFolderPaths(parsed);
}

export async function writeEmptyFolderPaths(
  userWorkspacePath: string,
  folderPaths: readonly string[]
): Promise<string[]> {
  return withMetadataLock(userWorkspacePath, () =>
    writeEmptyFolderPathsUnlocked(userWorkspacePath, folderPaths)
  );
}

async function writeEmptyFolderPathsUnlocked(
  userWorkspacePath: string,
  folderPaths: readonly string[]
): Promise<string[]> {
  const normalizedFolderPaths = normalizeFolderPaths(folderPaths);
  const filePath = getFoldersFilePath(userWorkspacePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(normalizedFolderPaths, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  return normalizedFolderPaths;
}

export async function recordEmptyFolderPath(
  userWorkspacePath: string,
  apiPath: string
): Promise<string[]> {
  const normalizedApiPath = normalizeApiPath(apiPath);
  if (normalizedApiPath === "/") {
    throw new WorkspaceError("PATH_INVALID", "Root folder cannot be recorded as empty.");
  }

  return withMetadataLock(userWorkspacePath, async () => {
    const folderPaths = await readEmptyFolderPaths(userWorkspacePath);
    return writeEmptyFolderPathsUnlocked(userWorkspacePath, [...folderPaths, normalizedApiPath]);
  });
}

export async function removeEmptyFolderPath(
  userWorkspacePath: string,
  apiPath: string,
  options: { includeChildren?: boolean } = {}
): Promise<string[]> {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const childPrefix = `${normalizedApiPath}/`;
  return withMetadataLock(userWorkspacePath, async () => {
    const folderPaths = await readEmptyFolderPaths(userWorkspacePath);
    const nextFolderPaths = folderPaths.filter((folderPath) => {
      if (folderPath === normalizedApiPath) {
        return false;
      }

      return !options.includeChildren || !folderPath.startsWith(childPrefix);
    });

    return writeEmptyFolderPathsUnlocked(userWorkspacePath, nextFolderPaths);
  });
}

export async function moveEmptyFolderPaths(
  userWorkspacePath: string,
  fromApiPath: string,
  toApiPath: string
): Promise<string[]> {
  const normalizedFromPath = normalizeApiPath(fromApiPath);
  const normalizedToPath = normalizeApiPath(toApiPath);
  const fromPrefix = `${normalizedFromPath}/`;
  return withMetadataLock(userWorkspacePath, async () => {
    const folderPaths = await readEmptyFolderPaths(userWorkspacePath);
    const nextFolderPaths = folderPaths.map((folderPath) => {
      if (folderPath === normalizedFromPath) {
        return normalizedToPath;
      }

      if (folderPath.startsWith(fromPrefix)) {
        return `${normalizedToPath}/${folderPath.slice(fromPrefix.length)}`;
      }

      return folderPath;
    });

    return writeEmptyFolderPathsUnlocked(userWorkspacePath, nextFolderPaths);
  });
}

export async function readMergedFolderEntries(
  userWorkspacePath: string,
  apiPath = "/"
): Promise<WorkspaceEntry[]> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  const entriesByPath = new Map<string, WorkspaceEntry>();
  let physicalFolderExists = true;

  try {
    const folderStat = await stat(workspacePath.absolutePath);
    if (!folderStat.isDirectory()) {
      throw new WorkspaceError("PATH_INVALID", "Path is not a folder.");
    }

    const realEntries = await readdir(workspacePath.absolutePath, { withFileTypes: true });
    for (const entry of realEntries) {
      if (protectedPathSegments.has(entry.name)) {
        continue;
      }

      const childPath = joinApiPath(workspacePath.apiPath, entry.name);
      entriesByPath.set(childPath, {
        name: entry.name,
        path: childPath,
        type: entry.isDirectory() ? "folder" : entry.name.endsWith(".md") ? "note" : "file"
      });
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      physicalFolderExists = false;
    } else {
      throw error;
    }
  }

  const emptyFolderPaths = await readEmptyFolderPaths(userWorkspacePath);
  for (const folderPath of emptyFolderPaths) {
    const childPath = getDirectChildPath(workspacePath.apiPath, folderPath);
    if (!childPath || entriesByPath.has(childPath)) {
      continue;
    }

    entriesByPath.set(childPath, {
      name: getApiPathName(childPath),
      path: childPath,
      type: "folder"
    });
  }

  if (
    !physicalFolderExists &&
    entriesByPath.size === 0 &&
    !emptyFolderPaths.includes(workspacePath.apiPath)
  ) {
    throw new WorkspaceError("PATH_NOT_FOUND", "Folder not found.", 404);
  }

  return [...entriesByPath.values()].sort(compareWorkspaceEntries);
}

export async function readWorkspaceTree(userWorkspacePath: string): Promise<WorkspaceTreeEntry> {
  return {
    name: "",
    path: "/",
    type: "folder",
    children: await readTreeChildren(userWorkspacePath, "/")
  };
}

export function getFileVersion(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function countMarkdownNotes(userWorkspacePath: string): Promise<number> {
  return countMarkdownNotesInDirectory(userWorkspacePath);
}

export async function assertCanAddMarkdownNotes(
  userRole: WorkspaceUserRole,
  userWorkspacePath: string,
  additionalNoteCount = 1,
  noteLimit = defaultMarkdownNoteLimit
): Promise<void> {
  if (!Number.isInteger(additionalNoteCount) || additionalNoteCount < 0) {
    throw new WorkspaceError(
      "VALIDATION_ERROR",
      "Additional note count must be a non-negative integer."
    );
  }

  if (userRole === "admin") {
    return;
  }

  const currentNoteCount = await countMarkdownNotes(userWorkspacePath);
  if (currentNoteCount + additionalNoteCount > noteLimit) {
    throw new WorkspaceError("NOTE_LIMIT_EXCEEDED", "Markdown note limit exceeded.", 403);
  }
}

function assertAllowedPathSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment === "..") {
      throw new WorkspaceError("PATH_INVALID", "Path cannot contain ...");
    }

    if (protectedPathSegments.has(segment)) {
      throw new WorkspaceError("PATH_INVALID", "Path contains a reserved segment.");
    }
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

function getFoldersFilePath(userWorkspacePath: string): string {
  return path.join(userWorkspacePath, metadataDirectoryName, foldersFileName);
}

async function withMetadataLock<T>(
  userWorkspacePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(userWorkspacePath);
  const previous = metadataLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current
  );
  metadataLocks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (metadataLocks.get(key) === queued) {
      metadataLocks.delete(key);
    }
  }
}

function normalizeFolderPaths(folderPaths: readonly string[]): string[] {
  const normalizedFolderPaths = new Set<string>();
  for (const folderPath of folderPaths) {
    const normalizedFolderPath = normalizeApiPath(folderPath);
    if (normalizedFolderPath !== "/") {
      normalizedFolderPaths.add(normalizedFolderPath);
    }
  }

  return [...normalizedFolderPaths].sort((left, right) => left.localeCompare(right));
}

export function joinApiPath(parentPath: string, childName: string): string {
  return parentPath === "/" ? `/${childName}` : `${parentPath}/${childName}`;
}

export function getApiPathName(apiPath: string): string {
  const index = apiPath.lastIndexOf("/");
  return apiPath.slice(index + 1);
}

function getDirectChildPath(parentPath: string, childPath: string): string | undefined {
  if (childPath === parentPath) {
    return undefined;
  }

  if (parentPath === "/") {
    const [childName] = childPath.slice(1).split("/");
    return childName ? `/${childName}` : undefined;
  }

  const childPrefix = `${parentPath}/`;
  if (!childPath.startsWith(childPrefix)) {
    return undefined;
  }

  const [childName] = childPath.slice(childPrefix.length).split("/");
  return childName ? `${parentPath}/${childName}` : undefined;
}

function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.type !== right.type) {
    if (left.type === "folder") {
      return -1;
    }

    if (right.type === "folder") {
      return 1;
    }
  }

  return left.name.localeCompare(right.name);
}

async function readTreeChildren(
  userWorkspacePath: string,
  apiPath: string
): Promise<WorkspaceTreeEntry[]> {
  const entries = await readMergedFolderEntries(userWorkspacePath, apiPath);

  return Promise.all(
    entries.map(async (entry) => {
      if (entry.type !== "folder") {
        return entry;
      }

      return {
        ...entry,
        children: await readTreeChildren(userWorkspacePath, entry.path)
      };
    })
  );
}

async function countMarkdownNotesInDirectory(directoryPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return 0;
    }

    throw error;
  }

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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { Minimatch } from "minimatch";
import { apiSuccess } from "../shared/api";
import { makeAuthenticate, requireCurrentUser } from "./auth";
import type { AuthenticatedUser, UserRole } from "./auth";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import {
  assertCanAddMarkdownNotes,
  ensureUserGitWorkspace,
  getFileVersion,
  getUserWorkspacePath,
  joinApiPath,
  normalizeApiPath,
  pathExists,
  readEmptyFolderPaths,
  removeEmptyFolderPath,
  resolveWorkspacePath,
  WorkspaceError,
  writeEmptyFolderPaths
} from "./workspace";

const execFileAsync = promisify(execFile);
const commandMaxBuffer = 20 * 1024 * 1024;
const protectedPathSegments = new Set([".git", ".notes-meta"]);
const defaultGlobLimit = 100;
const maxGlobLimit = 1000;

type GlobBody = {
  pattern?: unknown;
  glob?: unknown;
  limit?: unknown;
};

type GrepBody = {
  pattern?: unknown;
  regex?: unknown;
  ignoreCase?: unknown;
  glob?: unknown;
  context?: unknown;
};

type ReadQuery = {
  path?: unknown;
  offset?: unknown;
  limit?: unknown;
};

type ShareBody = {
  path?: unknown;
};

type ShareParams = {
  shareId: string;
};

type PublicShareParams = {
  slug: string;
};

type SearchEntry = {
  path: string;
  type: "folder" | "note";
  mtimeMs: number;
};

type LineResult = {
  lineNumber: number;
  content: string;
};

type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
  context: {
    before: LineResult[];
    after: LineResult[];
  };
};

type ImportConflict = {
  path: string;
  reason: string;
};

type ImportEntry = {
  path: string;
  content: Uint8Array;
};

type ImportPlan = {
  files: string[];
  folders: string[];
  conflicts: ImportConflict[];
  noteCount: number;
};

type ImportAnalysis = {
  plan: ImportPlan;
  fileEntries: ImportEntry[];
};

type ShareRow = {
  id: string;
  user_id: string;
  note_path: string;
  slug: string;
  commit_sha: string;
  active: boolean;
  created_at: Date | string;
};

export function registerExtensionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database
): void {
  const authenticate = makeAuthenticate(config, db);

  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.post<{ Body: GlobBody }>(
    "/api/search/glob",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const { pattern, limit } = readGlobBody(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const matcher = createGlobMatcher(pattern);
      const matches = (await listSearchEntries(userWorkspacePath))
        .filter((entry) => matcher.match(toRelativePath(entry.path)))
        .sort(compareSearchEntries)
        .slice(0, limit)
        .map(({ mtimeMs: _mtimeMs, ...entry }) => entry);

      return apiSuccess({ matches });
    }
  );

  app.post<{ Body: GrepBody }>(
    "/api/search/grep",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const grepRequest = readGrepBody(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);

      return apiSuccess({
        matches: await grepWorkspace(userWorkspacePath, grepRequest)
      });
    }
  );

  app.get<{ Querystring: ReadQuery }>(
    "/api/search/read",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const readRequest = readReadQuery(request.query);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);

      return apiSuccess({
        note: await readNoteLines(userWorkspacePath, readRequest.path, readRequest)
      });
    }
  );

  app.get("/api/export.zip", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply);
    if (!user) {
      return;
    }

    const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", 'attachment; filename="notes.zip"')
      .send(await createWorkspaceZip(userWorkspacePath));
  });

  app.post<{ Body: Buffer }>(
    "/api/import/dry-run",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const analysis = await analyzeImport(
        userWorkspacePath,
        user.role,
        readZipRequestBody(request.body)
      );

      return apiSuccess({ plan: analysis.plan });
    }
  );

  app.post<{ Body: Buffer }>(
    "/api/import",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const analysis = await analyzeImport(
        userWorkspacePath,
        user.role,
        readZipRequestBody(request.body)
      );

      if (analysis.plan.conflicts.length > 0) {
        throw new WorkspaceError("IMPORT_CONFLICT", "Zip import has conflicts.", 409);
      }

      await applyImport(userWorkspacePath, analysis);

      return apiSuccess({
        imported: {
          files: analysis.plan.files,
          folders: analysis.plan.folders
        }
      });
    }
  );

  app.post<{ Body: ShareBody }>(
    "/api/shares",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const notePath = readSharePath(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const commitSha = await assertCommittedNote(userWorkspacePath, notePath);
      const share = await createShare(db, config, user, notePath, commitSha);

      void reply.status(201).send(apiSuccess({ share }));
    }
  );

  app.get("/api/shares", { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireCurrentUser(request, reply);
    if (!user) {
      return;
    }

    return apiSuccess({
      shares: await listShares(db, config, user.id)
    });
  });

  app.delete<{ Params: ShareParams }>(
    "/api/shares/:shareId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const share = await unpublishShare(db, config, user.id, request.params.shareId);
      if (!share) {
        throw new WorkspaceError("SHARE_NOT_FOUND", "Share not found.", 404);
      }

      return apiSuccess({ share });
    }
  );

  app.get<{ Params: PublicShareParams }>("/s/:slug", async (request) => {
    return readPublicShare(db, config, request.params.slug);
  });

  app.get<{ Params: PublicShareParams }>("/api/shares/public/:slug", async (request) => {
    return readPublicShare(db, config, request.params.slug);
  });
}

function readGlobBody(body: GlobBody | undefined): { pattern: string; limit: number } {
  const rawPattern = body?.pattern ?? body?.glob ?? "**/*";
  if (typeof rawPattern !== "string" || !rawPattern.trim()) {
    throw new WorkspaceError("VALIDATION_ERROR", "Glob pattern is required.");
  }

  return {
    pattern: normalizeGlobPattern(rawPattern),
    limit: readInteger(body?.limit, defaultGlobLimit, 1, maxGlobLimit, "limit")
  };
}

function readGrepBody(body: GrepBody | undefined): {
  pattern: string;
  regex: boolean;
  ignoreCase: boolean;
  glob?: string;
  context: number;
} {
  if (!body || typeof body.pattern !== "string" || !body.pattern) {
    throw new WorkspaceError("VALIDATION_ERROR", "Search pattern is required.");
  }

  if (body.regex !== undefined && typeof body.regex !== "boolean") {
    throw new WorkspaceError("VALIDATION_ERROR", "regex must be a boolean.");
  }

  if (body.ignoreCase !== undefined && typeof body.ignoreCase !== "boolean") {
    throw new WorkspaceError("VALIDATION_ERROR", "ignoreCase must be a boolean.");
  }

  return {
    pattern: body.pattern,
    regex: body.regex === true,
    ignoreCase: body.ignoreCase === true,
    glob:
      body.glob === undefined
        ? undefined
        : normalizeGlobPattern(readRequiredString(body.glob, "glob")),
    context: readInteger(body.context, 0, 0, 10, "context")
  };
}

function readReadQuery(query: ReadQuery): { path: string; offset?: number; limit?: number } {
  if (typeof query.path !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Path is required.");
  }

  return {
    path: assertMarkdownNotePath(query.path),
    offset:
      query.offset === undefined
        ? undefined
        : readInteger(query.offset, 1, 1, Number.MAX_SAFE_INTEGER, "offset"),
    limit:
      query.limit === undefined
        ? undefined
        : readInteger(query.limit, 1, 1, Number.MAX_SAFE_INTEGER, "limit")
  };
}

function readSharePath(body: ShareBody | undefined): string {
  if (!body || typeof body.path !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Path is required.");
  }

  return assertMarkdownNotePath(body.path);
}

function readZipRequestBody(body: Buffer | undefined): Buffer {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new WorkspaceError("VALIDATION_ERROR", "Zip file body is required.");
  }

  return body;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceError("VALIDATION_ERROR", `${fieldName} is required.`);
  }

  return value;
}

function readInteger(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new WorkspaceError("VALIDATION_ERROR", `${fieldName} must be an integer.`);
  }

  return parsed;
}

function normalizeGlobPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new WorkspaceError("GLOB_INVALID", "Glob pattern contains invalid characters.");
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");
  const normalized = withoutLeadingSlash || "**/*";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || protectedPathSegments.has(segment))) {
    throw new WorkspaceError("GLOB_INVALID", "Glob pattern contains a reserved segment.");
  }

  try {
    createGlobMatcher(normalized);
  } catch {
    throw new WorkspaceError("GLOB_INVALID", "Glob pattern is invalid.");
  }

  return normalized;
}

function createGlobMatcher(pattern: string): Minimatch {
  return new Minimatch(pattern, {
    dot: false,
    nonegate: true
  });
}

async function listSearchEntries(userWorkspacePath: string): Promise<SearchEntry[]> {
  const entriesByPath = new Map<string, SearchEntry>();
  await scanSearchEntries(userWorkspacePath, "/", entriesByPath);

  for (const folderPath of await readEmptyFolderPaths(userWorkspacePath)) {
    entriesByPath.set(folderPath, {
      path: folderPath,
      type: "folder",
      mtimeMs: entriesByPath.get(folderPath)?.mtimeMs ?? 0
    });
  }

  return [...entriesByPath.values()];
}

async function scanSearchEntries(
  absoluteFolderPath: string,
  apiFolderPath: string,
  entriesByPath: Map<string, SearchEntry>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absoluteFolderPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (protectedPathSegments.has(entry.name)) {
      continue;
    }

    const childAbsolutePath = path.join(absoluteFolderPath, entry.name);
    const childApiPath = joinApiPath(apiFolderPath, entry.name);
    const childStat = await stat(childAbsolutePath);

    if (entry.isDirectory()) {
      entriesByPath.set(childApiPath, {
        path: childApiPath,
        type: "folder",
        mtimeMs: childStat.mtimeMs
      });
      await scanSearchEntries(childAbsolutePath, childApiPath, entriesByPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      entriesByPath.set(childApiPath, {
        path: childApiPath,
        type: "note",
        mtimeMs: childStat.mtimeMs
      });
    }
  }
}

function compareSearchEntries(left: SearchEntry, right: SearchEntry): number {
  if (left.mtimeMs !== right.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }

  return left.path.localeCompare(right.path);
}

function toRelativePath(apiPath: string): string {
  return normalizeApiPath(apiPath).slice(1);
}

async function grepWorkspace(
  userWorkspacePath: string,
  request: {
    pattern: string;
    regex: boolean;
    ignoreCase: boolean;
    glob?: string;
    context: number;
  }
): Promise<GrepMatch[]> {
  const args = ["--json", "--color", "never", "--glob", "**/*.md"];
  if (!request.regex) {
    args.push("--fixed-strings");
  }

  if (request.ignoreCase) {
    args.push("--ignore-case");
  }

  if (request.glob) {
    args.push("--glob", request.glob);
  }

  args.push(request.pattern, ".");

  let output: string;
  try {
    output = await runCommand("rg", args, userWorkspacePath, [0, 1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed.";
    if (message.toLowerCase().includes("glob")) {
      throw new WorkspaceError("GLOB_INVALID", "Glob pattern is invalid.");
    }

    throw new WorkspaceError("REGEX_INVALID", "Regular expression is invalid.");
  }

  const matches = parseRipgrepMatches(output);
  return Promise.all(
    matches.map(async (match) => ({
      ...match,
      context:
        request.context > 0
          ? await readLineContext(userWorkspacePath, match.path, match.lineNumber, request.context)
          : { before: [], after: [] }
    }))
  );
}

function parseRipgrepMatches(output: string): Omit<GrepMatch, "context">[] {
  const matches: Omit<GrepMatch, "context">[] = [];
  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }

    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
      };
    };
    if (event.type !== "match" || !event.data?.path?.text || !event.data.lines) {
      continue;
    }

    const apiPath = gitPathToApiPath(event.data.path.text);
    if (hasProtectedPathSegment(apiPath)) {
      continue;
    }

    matches.push({
      path: apiPath,
      lineNumber: event.data.line_number ?? 0,
      line: trimLineEnding(event.data.lines.text ?? "")
    });
  }

  return matches;
}

async function readLineContext(
  userWorkspacePath: string,
  apiPath: string,
  lineNumber: number,
  contextSize: number
): Promise<GrepMatch["context"]> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  const lines = splitContentLines(await readFile(workspacePath.absolutePath, "utf8"));
  const lineIndex = lineNumber - 1;
  const beforeStart = Math.max(0, lineIndex - contextSize);
  const before = lines.slice(beforeStart, lineIndex).map((content, index) => ({
    lineNumber: beforeStart + index + 1,
    content
  }));
  const after = lines.slice(lineIndex + 1, lineIndex + 1 + contextSize).map((content, index) => ({
    lineNumber: lineNumber + index + 1,
    content
  }));

  return { before, after };
}

async function readNoteLines(
  userWorkspacePath: string,
  apiPath: string,
  request: { offset?: number; limit?: number }
) {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  await assertExistingFile(workspacePath.absolutePath, "Note not found.");
  const content = await readFile(workspacePath.absolutePath, "utf8");
  const allLines = splitContentLines(content);
  const offset = request.offset ?? 1;
  const startIndex = offset - 1;
  const endIndex = request.limit === undefined ? allLines.length : startIndex + request.limit;
  const selectedLines = allLines.slice(startIndex, endIndex).map((line, index) => ({
    lineNumber: offset + index,
    content: line
  }));

  return {
    path: workspacePath.apiPath,
    content:
      request.offset === undefined && request.limit === undefined
        ? content
        : selectedLines.map((line) => line.content).join("\n"),
    fileVersion: getFileVersion(content),
    lines: selectedLines
  };
}

async function createWorkspaceZip(userWorkspacePath: string): Promise<Buffer> {
  const zippable: Zippable = {};
  await addWorkspaceEntriesToZip(userWorkspacePath, "", zippable);

  for (const folderPath of await readEmptyFolderPaths(userWorkspacePath)) {
    zippable[`${toRelativePath(folderPath)}/`] ??= new Uint8Array(0);
  }

  return Buffer.from(zipSync(zippable, { level: 6 }));
}

async function addWorkspaceEntriesToZip(
  absoluteFolderPath: string,
  relativeFolderPath: string,
  zippable: Zippable
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absoluteFolderPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (protectedPathSegments.has(entry.name)) {
      continue;
    }

    const childRelativePath = relativeFolderPath
      ? `${relativeFolderPath}/${entry.name}`
      : entry.name;
    const childAbsolutePath = path.join(absoluteFolderPath, entry.name);

    if (entry.isDirectory()) {
      zippable[`${childRelativePath}/`] = new Uint8Array(0);
      await addWorkspaceEntriesToZip(childAbsolutePath, childRelativePath, zippable);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      zippable[childRelativePath] = strToU8(await readFile(childAbsolutePath, "utf8"));
    }
  }
}

async function analyzeImport(
  userWorkspacePath: string,
  userRole: UserRole,
  archive: Buffer
): Promise<ImportAnalysis> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(archive));
  } catch {
    throw new WorkspaceError("VALIDATION_ERROR", "Zip file is invalid.");
  }

  const conflicts: ImportConflict[] = [];
  const folderPaths = new Set<string>();
  const fileEntries: ImportEntry[] = [];
  const importedPaths = new Map<string, "file" | "folder">();

  for (const [zipPath, content] of Object.entries(unzipped)) {
    const normalized = normalizeZipEntryPath(zipPath);
    if (!normalized) {
      continue;
    }

    if (normalized.conflict) {
      conflicts.push({
        path: normalized.path,
        reason: normalized.conflict
      });
      continue;
    }

    if (!normalized.type) {
      continue;
    }

    const previousType = importedPaths.get(normalized.path);
    if (previousType && previousType !== normalized.type) {
      conflicts.push({
        path: normalized.path,
        reason: "Zip contains both a file and a folder at this path."
      });
      continue;
    }

    importedPaths.set(normalized.path, normalized.type);
    if (normalized.type === "folder") {
      folderPaths.add(normalized.path);
    } else {
      fileEntries.push({
        path: normalized.path,
        content
      });
    }
  }

  await addWorkspaceImportConflicts(userWorkspacePath, fileEntries, folderPaths, conflicts);
  if (conflicts.length === 0) {
    await assertCanAddMarkdownNotes(userRole, userWorkspacePath, fileEntries.length);
  }

  return {
    plan: {
      files: fileEntries
        .map((entry) => entry.path)
        .sort((left, right) => left.localeCompare(right)),
      folders: [...folderPaths].sort((left, right) => left.localeCompare(right)),
      conflicts,
      noteCount: fileEntries.length
    },
    fileEntries
  };
}

function normalizeZipEntryPath(
  zipPath: string
):
  | { path: string; type: "file" | "folder"; conflict?: undefined }
  | { path: string; type?: undefined; conflict: string }
  | undefined {
  if (!zipPath || zipPath === "/") {
    return undefined;
  }

  if (zipPath.includes("\\") || zipPath.includes("\0") || path.posix.isAbsolute(zipPath)) {
    return {
      path: `/${zipPath.replace(/^\/+/, "")}`,
      conflict: "Zip entry path is invalid."
    };
  }

  const isFolder = zipPath.endsWith("/");
  const cleanedPath = zipPath.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!cleanedPath) {
    return undefined;
  }

  const apiPath = `/${cleanedPath}`;
  try {
    normalizeApiPath(apiPath);
  } catch {
    return {
      path: apiPath,
      conflict: "Zip entry path is invalid."
    };
  }

  if (!isFolder && !apiPath.endsWith(".md")) {
    return {
      path: apiPath,
      conflict: "Only Markdown files can be imported."
    };
  }

  return {
    path: normalizeApiPath(apiPath),
    type: isFolder ? "folder" : "file"
  };
}

async function addWorkspaceImportConflicts(
  userWorkspacePath: string,
  fileEntries: ImportEntry[],
  folderPaths: Set<string>,
  conflicts: ImportConflict[]
): Promise<void> {
  const emptyFolderPaths = new Set(await readEmptyFolderPaths(userWorkspacePath));
  const importedFilePaths = new Set(fileEntries.map((entry) => entry.path));

  for (const folderPath of folderPaths) {
    if (importedFilePaths.has(folderPath)) {
      conflicts.push({
        path: folderPath,
        reason: "Zip contains both a file and a folder at this path."
      });
      continue;
    }

    const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
    if (await pathExists(workspacePath.absolutePath)) {
      const entryStat = await stat(workspacePath.absolutePath);
      if (!entryStat.isDirectory()) {
        conflicts.push({
          path: folderPath,
          reason: "A file already exists at this folder path."
        });
      }
    }
  }

  for (const fileEntry of fileEntries) {
    const workspacePath = resolveWorkspacePath(userWorkspacePath, fileEntry.path);
    if ((await pathExists(workspacePath.absolutePath)) || emptyFolderPaths.has(fileEntry.path)) {
      conflicts.push({
        path: fileEntry.path,
        reason: "Path already exists."
      });
      continue;
    }

    for (const parentPath of getParentPaths(fileEntry.path)) {
      const parentWorkspacePath = resolveWorkspacePath(userWorkspacePath, parentPath);
      if (
        (await pathExists(parentWorkspacePath.absolutePath)) &&
        !(await stat(parentWorkspacePath.absolutePath)).isDirectory()
      ) {
        conflicts.push({
          path: fileEntry.path,
          reason: "A parent path is not a folder."
        });
        break;
      }
    }
  }
}

async function applyImport(userWorkspacePath: string, analysis: ImportAnalysis): Promise<void> {
  for (const folderPath of analysis.plan.folders) {
    const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
    await mkdir(workspacePath.absolutePath, { recursive: true });
  }

  for (const fileEntry of analysis.fileEntries) {
    const workspacePath = resolveWorkspacePath(userWorkspacePath, fileEntry.path);
    await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
    await writeFile(workspacePath.absolutePath, strFromU8(fileEntry.content), "utf8");
    await removeEmptyFolderPath(userWorkspacePath, getParentApiPath(workspacePath.apiPath));
  }

  const currentEmptyFolders = new Set(await readEmptyFolderPaths(userWorkspacePath));
  for (const folderPath of analysis.plan.folders) {
    const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
    if (await isPhysicalDirectoryEmpty(workspacePath.absolutePath)) {
      currentEmptyFolders.add(workspacePath.apiPath);
    } else {
      currentEmptyFolders.delete(workspacePath.apiPath);
    }
  }

  await writeEmptyFolderPaths(userWorkspacePath, [...currentEmptyFolders]);
}

async function createShare(
  db: Database,
  config: AppConfig,
  user: AuthenticatedUser,
  notePath: string,
  commitSha: string
) {
  const result = await db.query<ShareRow>(
    `
      insert into shares (id, user_id, note_path, slug, commit_sha, active)
      values ($1, $2, $3, $4, $5, true)
      returning id, user_id, note_path, slug, commit_sha, active, created_at
    `,
    [randomUUID(), user.id, notePath, createShareSlug(), commitSha]
  );

  return toShareResponse(config, result.rows[0]);
}

async function listShares(db: Database, config: AppConfig, userId: string) {
  const result = await db.query<ShareRow>(
    `
      select id, user_id, note_path, slug, commit_sha, active, created_at
      from shares
      where user_id = $1
        and active = true
      order by created_at desc
    `,
    [userId]
  );

  return result.rows.map((share) => toShareResponse(config, share));
}

async function unpublishShare(db: Database, config: AppConfig, userId: string, shareId: string) {
  const result = await db.query<ShareRow>(
    `
      update shares
      set active = false
      where id = $1
        and user_id = $2
        and active = true
      returning id, user_id, note_path, slug, commit_sha, active, created_at
    `,
    [shareId, userId]
  );

  return result.rows[0] ? toShareResponse(config, result.rows[0]) : undefined;
}

async function findActiveShareBySlug(db: Database, slug: string): Promise<ShareRow | undefined> {
  const result = await db.query<ShareRow>(
    `
      select id, user_id, note_path, slug, commit_sha, active, created_at
      from shares
      where slug = $1
        and active = true
    `,
    [slug]
  );

  return result.rows[0];
}

async function readPublicShare(db: Database, config: AppConfig, slug: string) {
  const share = await findActiveShareBySlug(db, slug);
  if (!share) {
    throw new WorkspaceError("SHARE_NOT_FOUND", "Share not found.", 404);
  }

  const userWorkspacePath = getUserWorkspacePath(config.workspaceRoot, share.user_id);
  if (!(await isPathPresentAtHead(userWorkspacePath, share.note_path))) {
    throw new WorkspaceError("SHARE_NOT_FOUND", "Share not found.", 404);
  }

  const content = await readShareContent(userWorkspacePath, share);

  return apiSuccess({
    share: {
      ...toShareResponse(config, share),
      content,
      fileVersion: getFileVersion(content)
    }
  });
}

function toShareResponse(config: AppConfig, share: ShareRow) {
  return {
    id: share.id,
    notePath: share.note_path,
    slug: share.slug,
    url: `${config.publicBaseUrl.replace(/\/$/, "")}/s/${share.slug}`,
    commitSha: share.commit_sha,
    active: share.active,
    createdAt:
      share.created_at instanceof Date
        ? share.created_at.toISOString()
        : new Date(share.created_at).toISOString()
  };
}

function createShareSlug(): string {
  return randomBytes(9).toString("base64url");
}

async function assertCommittedNote(userWorkspacePath: string, apiPath: string): Promise<string> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  const headSha = await getHeadCommitSha(userWorkspacePath);
  if (!headSha) {
    throw new WorkspaceError("NOTE_NOT_COMMITTED", "Note has not been committed.", 409);
  }

  try {
    const objectType = (
      await runCommand(
        "git",
        ["cat-file", "-t", `${headSha}:${workspacePath.relativePath}`],
        userWorkspacePath
      )
    ).trim();
    if (objectType !== "blob") {
      throw new WorkspaceError(
        "NOTE_NOT_COMMITTED",
        "Only committed Markdown notes can be shared.",
        409
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }

    throw new WorkspaceError("NOTE_NOT_COMMITTED", "Note has not been committed.", 409);
  }

  const noteStatus = await runCommand(
    "git",
    ["status", "--porcelain", "--", workspacePath.relativePath],
    userWorkspacePath
  );
  if (noteStatus.trim()) {
    throw new WorkspaceError("NOTE_NOT_COMMITTED", "Note has uncommitted changes.", 409);
  }

  return headSha;
}

async function getHeadCommitSha(userWorkspacePath: string): Promise<string | undefined> {
  try {
    return (await runCommand("git", ["rev-parse", "--verify", "HEAD"], userWorkspacePath)).trim();
  } catch {
    return undefined;
  }
}

async function isPathPresentAtHead(userWorkspacePath: string, apiPath: string): Promise<boolean> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  try {
    const objectType = (
      await runCommand(
        "git",
        ["cat-file", "-t", `HEAD:${workspacePath.relativePath}`],
        userWorkspacePath
      )
    ).trim();
    return objectType === "blob";
  } catch {
    return false;
  }
}

async function readShareContent(userWorkspacePath: string, share: ShareRow): Promise<string> {
  const workspacePath = resolveWorkspacePath(userWorkspacePath, share.note_path);
  try {
    return await runCommand(
      "git",
      ["show", `${share.commit_sha}:${workspacePath.relativePath}`],
      userWorkspacePath
    );
  } catch {
    throw new WorkspaceError("SHARE_NOT_FOUND", "Share not found.", 404);
  }
}

function assertMarkdownNotePath(apiPath: string): string {
  const normalizedApiPath = normalizeApiPath(apiPath);
  if (!normalizedApiPath.endsWith(".md")) {
    throw new WorkspaceError("PATH_INVALID", "Note path must end with .md.");
  }

  return normalizedApiPath;
}

async function assertExistingFile(absolutePath: string, notFoundMessage: string): Promise<void> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new WorkspaceError("PATH_INVALID", "Path is not a file.");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new WorkspaceError("PATH_NOT_FOUND", notFoundMessage, 404);
    }

    throw error;
  }
}

function splitContentLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const withoutFinalLineEnding = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutFinalLineEnding.split(/\r?\n/);
}

function trimLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function gitPathToApiPath(gitPath: string): string {
  const normalized = path.posix.normalize(`/${gitPath.replace(/^\.\//, "").replaceAll("\\", "/")}`);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function hasProtectedPathSegment(apiPath: string): boolean {
  return apiPath.split("/").some((segment) => protectedPathSegments.has(segment));
}

function getParentPaths(apiPath: string): string[] {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const segments = normalizedApiPath.slice(1).split("/").slice(0, -1);
  const parentPaths: string[] = [];
  let currentPath = "/";

  for (const segment of segments) {
    currentPath = joinApiPath(currentPath, segment);
    parentPaths.push(currentPath);
  }

  return parentPaths;
}

function getParentApiPath(apiPath: string): string {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const parentPath = path.posix.dirname(normalizedApiPath);
  return parentPath === "." ? "/" : parentPath;
}

async function isPhysicalDirectoryEmpty(absolutePath: string): Promise<boolean> {
  const entries = await readdir(absolutePath);
  return entries.length === 0;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: commandMaxBuffer,
      timeout: 10000
    });
    return stdout;
  } catch (error) {
    const exitCode = getExitCode(error);
    if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
      return getProcessOutput(error, "stdout");
    }

    const stderr = getProcessOutput(error, "stderr");
    throw new Error(stderr || `${command} command failed.`);
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

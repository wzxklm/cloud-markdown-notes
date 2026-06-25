import type { FastifyInstance } from "fastify";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiSuccess } from "../shared/api";
import { makeAuthenticate, requireCurrentUser } from "./auth";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import {
  assertCanAddMarkdownNotes,
  assertWorkspacePathAvailable,
  ensureUserGitWorkspace,
  getFileVersion,
  moveEmptyFolderPaths,
  normalizeApiPath,
  readMergedFolderEntries,
  readWorkspaceTree,
  recordEmptyFolderPath,
  removeEmptyFolderPath,
  resolveWorkspacePath,
  WorkspaceError
} from "./workspace";

type PathBody = {
  path?: unknown;
};

type NoteBody = PathBody & {
  content?: unknown;
};

type ReplaceNoteBody = {
  content?: unknown;
  ifMatch?: unknown;
};

type EditNoteBody = ReplaceNoteBody & {
  fromLine?: unknown;
  toLine?: unknown;
};

type MoveBody = {
  fromPath?: unknown;
  toPath?: unknown;
};

type PathQuery = {
  path?: unknown;
};

type NoteResponse = {
  path: string;
  content: string;
  fileVersion: string;
};

export function registerContentRoutes(app: FastifyInstance, config: AppConfig, db: Database): void {
  const authenticate = makeAuthenticate(config, db);

  app.post<{ Body: PathBody }>(
    "/api/folders",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const folderPath = readBodyPath(request.body);
      const workspacePath = await assertWorkspacePathAvailable(userWorkspacePath, folderPath);
      assertNotRoot(workspacePath.apiPath);
      await assertParentFolderExists(userWorkspacePath, workspacePath.apiPath);

      await mkdir(workspacePath.absolutePath, { recursive: true });
      await removeEmptyFolderPath(userWorkspacePath, getParentApiPath(workspacePath.apiPath));
      await recordEmptyFolderPath(userWorkspacePath, workspacePath.apiPath);

      void reply.status(201).send(
        apiSuccess({
          folder: {
            name: getApiPathName(workspacePath.apiPath),
            path: workspacePath.apiPath,
            type: "folder" as const
          }
        })
      );
    }
  );

  app.get<{ Querystring: PathQuery }>(
    "/api/folders",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const folderPath = readQueryPath(request.query, "/");
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
      const entries = await readMergedFolderEntries(userWorkspacePath, workspacePath.apiPath);

      return apiSuccess({
        path: workspacePath.apiPath,
        entries
      });
    }
  );

  app.get(
    "/api/tree",
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
        tree: await readWorkspaceTree(userWorkspacePath)
      });
    }
  );

  app.patch<{ Body: MoveBody }>(
    "/api/folders/move",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const { fromPath, toPath } = readMoveBody(request.body);
      const fromWorkspacePath = resolveWorkspacePath(userWorkspacePath, fromPath);
      const toWorkspacePath = await assertWorkspacePathAvailable(userWorkspacePath, toPath);
      assertNotRoot(fromWorkspacePath.apiPath);
      assertNotRoot(toWorkspacePath.apiPath);
      await assertExistingFolder(userWorkspacePath, fromWorkspacePath.apiPath);
      await assertParentFolderExists(userWorkspacePath, toWorkspacePath.apiPath);

      if (toWorkspacePath.apiPath.startsWith(`${fromWorkspacePath.apiPath}/`)) {
        throw new WorkspaceError("PATH_INVALID", "Folder cannot be moved into itself.");
      }

      const toParentPath = getParentApiPath(toWorkspacePath.apiPath);
      await mkdir(path.dirname(toWorkspacePath.absolutePath), { recursive: true });
      if (await physicalPathExists(fromWorkspacePath.absolutePath)) {
        await rename(fromWorkspacePath.absolutePath, toWorkspacePath.absolutePath);
      }

      await moveEmptyFolderPaths(
        userWorkspacePath,
        fromWorkspacePath.apiPath,
        toWorkspacePath.apiPath
      );
      await refreshEmptyFolderRecord(
        userWorkspacePath,
        getParentApiPath(fromWorkspacePath.apiPath)
      );
      await removeEmptyFolderPath(userWorkspacePath, toParentPath);

      return apiSuccess({
        folder: {
          name: getApiPathName(toWorkspacePath.apiPath),
          path: toWorkspacePath.apiPath,
          type: "folder" as const
        }
      });
    }
  );

  app.delete<{ Querystring: PathQuery }>(
    "/api/folders",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const folderPath = readQueryPath(request.query);
      const workspacePath = resolveWorkspacePath(userWorkspacePath, folderPath);
      assertNotRoot(workspacePath.apiPath);
      await assertExistingFolder(userWorkspacePath, workspacePath.apiPath);

      if (await physicalPathExists(workspacePath.absolutePath)) {
        await rm(workspacePath.absolutePath, { recursive: true, force: true });
      }

      await removeEmptyFolderPath(userWorkspacePath, workspacePath.apiPath, {
        includeChildren: true
      });
      await refreshEmptyFolderRecord(userWorkspacePath, getParentApiPath(workspacePath.apiPath));

      return apiSuccess({ ok: true });
    }
  );

  app.post<{ Body: NoteBody }>(
    "/api/notes",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const notePath = readBodyPath(request.body);
      const content = readOptionalContent(request.body?.content);
      assertMarkdownNotePath(notePath);
      const workspacePath = await assertWorkspacePathAvailable(userWorkspacePath, notePath);
      await assertParentFolderExists(userWorkspacePath, workspacePath.apiPath);
      await assertCanAddMarkdownNotes(user.role, userWorkspacePath, 1);

      await mkdir(path.dirname(workspacePath.absolutePath), { recursive: true });
      await writeFile(workspacePath.absolutePath, content, "utf8");
      await removeEmptyFolderPath(userWorkspacePath, getParentApiPath(workspacePath.apiPath));

      void reply.status(201).send(
        apiSuccess({
          note: toNoteResponse(workspacePath.apiPath, content)
        })
      );
    }
  );

  app.get<{ Querystring: PathQuery }>(
    "/api/notes",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const notePath = readQueryPath(request.query);
      const note = await readExistingNote(userWorkspacePath, notePath);

      return apiSuccess({ note });
    }
  );

  app.put<{ Querystring: PathQuery; Body: ReplaceNoteBody }>(
    "/api/notes",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const content = readRequiredContent(request.body?.content);
      const ifMatch = readIfMatch(request.body?.ifMatch);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const notePath = readQueryPath(request.query);
      const currentNote = await readExistingNote(userWorkspacePath, notePath);
      if (currentNote.fileVersion !== ifMatch) {
        throw new WorkspaceError("EDIT_CONFLICT", "Note has been modified.", 409);
      }

      const workspacePath = resolveWorkspacePath(userWorkspacePath, notePath);
      await writeFile(workspacePath.absolutePath, content, "utf8");

      return apiSuccess({
        note: toNoteResponse(workspacePath.apiPath, content)
      });
    }
  );

  app.patch<{ Querystring: PathQuery; Body: EditNoteBody }>(
    "/api/notes",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const edit = readEditNoteBody(request.body);
      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const notePath = readQueryPath(request.query);
      const currentNote = await readExistingNote(userWorkspacePath, notePath);
      if (currentNote.fileVersion !== edit.ifMatch) {
        throw new WorkspaceError("EDIT_CONFLICT", "Note has been modified.", 409);
      }

      const workspacePath = resolveWorkspacePath(userWorkspacePath, notePath);
      const content = applyLineEdit(currentNote.content, edit);
      await writeFile(workspacePath.absolutePath, content, "utf8");

      return apiSuccess({
        note: toNoteResponse(workspacePath.apiPath, content)
      });
    }
  );

  app.patch<{ Body: MoveBody }>(
    "/api/notes/move",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const { fromPath, toPath } = readMoveBody(request.body);
      assertMarkdownNotePath(fromPath);
      assertMarkdownNotePath(toPath);
      const fromWorkspacePath = resolveWorkspacePath(userWorkspacePath, fromPath);
      const toWorkspacePath = await assertWorkspacePathAvailable(userWorkspacePath, toPath);
      await assertExistingNotePath(fromWorkspacePath.absolutePath);
      await assertParentFolderExists(userWorkspacePath, toWorkspacePath.apiPath);

      await mkdir(path.dirname(toWorkspacePath.absolutePath), { recursive: true });
      await rename(fromWorkspacePath.absolutePath, toWorkspacePath.absolutePath);
      await refreshEmptyFolderRecord(
        userWorkspacePath,
        getParentApiPath(fromWorkspacePath.apiPath)
      );
      await removeEmptyFolderPath(userWorkspacePath, getParentApiPath(toWorkspacePath.apiPath));

      const content = await readFile(toWorkspacePath.absolutePath, "utf8");
      return apiSuccess({
        note: toNoteResponse(toWorkspacePath.apiPath, content)
      });
    }
  );

  app.delete<{ Querystring: PathQuery }>(
    "/api/notes",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      const userWorkspacePath = await ensureUserGitWorkspace(config.workspaceRoot, user.id);
      const notePath = readQueryPath(request.query);
      assertMarkdownNotePath(notePath);
      const workspacePath = resolveWorkspacePath(userWorkspacePath, notePath);
      await assertExistingNotePath(workspacePath.absolutePath);
      await rm(workspacePath.absolutePath, { force: true });
      await refreshEmptyFolderRecord(userWorkspacePath, getParentApiPath(workspacePath.apiPath));

      return apiSuccess({ ok: true });
    }
  );
}

function readBodyPath(body: PathBody | undefined): string {
  if (!body || typeof body.path !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Path is required.");
  }

  return normalizeApiPath(body.path);
}

function readQueryPath(query: PathQuery, defaultPath?: string): string {
  if (query.path === undefined && defaultPath !== undefined) {
    return normalizeApiPath(defaultPath);
  }

  if (typeof query.path !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Path is required.");
  }

  return normalizeApiPath(query.path);
}

function readMoveBody(body: MoveBody | undefined): { fromPath: string; toPath: string } {
  if (!body || typeof body.fromPath !== "string" || typeof body.toPath !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "fromPath and toPath are required.");
  }

  return {
    fromPath: normalizeApiPath(body.fromPath),
    toPath: normalizeApiPath(body.toPath)
  };
}

function readOptionalContent(content: unknown): string {
  if (content === undefined) {
    return "";
  }

  return readRequiredContent(content);
}

function readRequiredContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new WorkspaceError("VALIDATION_ERROR", "Content is required.");
  }

  return content;
}

function readIfMatch(ifMatch: unknown): string {
  if (typeof ifMatch !== "string" || !ifMatch) {
    throw new WorkspaceError("VALIDATION_ERROR", "ifMatch is required.");
  }

  return ifMatch;
}

function readEditNoteBody(body: EditNoteBody | undefined): {
  ifMatch: string;
  fromLine: number;
  toLine: number;
  content: string;
} {
  const fromLine = readLineNumber(body?.fromLine, "fromLine");
  const toLine = readLineNumber(body?.toLine, "toLine");
  if (fromLine > toLine) {
    throw new WorkspaceError("VALIDATION_ERROR", "fromLine must be less than or equal to toLine.");
  }

  return {
    ifMatch: readIfMatch(body?.ifMatch),
    fromLine,
    toLine,
    content: readRequiredContent(body?.content)
  };
}

function readLineNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceError("VALIDATION_ERROR", `${fieldName} must be a positive integer.`);
  }

  return value;
}

function applyLineEdit(
  currentContent: string,
  edit: { fromLine: number; toLine: number; content: string }
): string {
  const currentLines = splitContentLines(currentContent);
  if (edit.fromLine > currentLines.length || edit.toLine > currentLines.length) {
    throw new WorkspaceError("VALIDATION_ERROR", "Line range is outside the current note.");
  }

  const replacementLines = edit.content === "" ? [] : splitContentLines(edit.content);
  const nextLines = [
    ...currentLines.slice(0, edit.fromLine - 1),
    ...replacementLines,
    ...currentLines.slice(edit.toLine)
  ];
  if (nextLines.length === 0) {
    return "";
  }

  const preservesFinalLineEnding =
    currentContent.endsWith("\n") ||
    (edit.toLine === currentLines.length && edit.content.endsWith("\n"));
  return `${nextLines.join("\n")}${preservesFinalLineEnding ? "\n" : ""}`;
}

function splitContentLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const withoutFinalLineEnding = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutFinalLineEnding.split(/\r?\n/);
}

function assertMarkdownNotePath(apiPath: string): void {
  const normalizedApiPath = normalizeApiPath(apiPath);
  if (!normalizedApiPath.endsWith(".md")) {
    throw new WorkspaceError("PATH_INVALID", "Note path must end with .md.");
  }
}

function assertNotRoot(apiPath: string): void {
  if (normalizeApiPath(apiPath) === "/") {
    throw new WorkspaceError("PATH_INVALID", "Root path cannot be modified.");
  }
}

async function assertParentFolderExists(userWorkspacePath: string, apiPath: string): Promise<void> {
  await assertExistingFolder(userWorkspacePath, getParentApiPath(apiPath));
}

async function assertExistingFolder(userWorkspacePath: string, apiPath: string): Promise<void> {
  await readMergedFolderEntries(userWorkspacePath, apiPath);
}

async function readExistingNote(userWorkspacePath: string, apiPath: string): Promise<NoteResponse> {
  assertMarkdownNotePath(apiPath);
  const workspacePath = resolveWorkspacePath(userWorkspacePath, apiPath);
  await assertExistingNotePath(workspacePath.absolutePath);
  const content = await readFile(workspacePath.absolutePath, "utf8");

  return toNoteResponse(workspacePath.apiPath, content);
}

async function assertExistingNotePath(absolutePath: string): Promise<void> {
  try {
    const noteStat = await stat(absolutePath);
    if (!noteStat.isFile()) {
      throw new WorkspaceError("PATH_INVALID", "Path is not a note.");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new WorkspaceError("PATH_NOT_FOUND", "Note not found.", 404);
    }

    throw error;
  }
}

async function refreshEmptyFolderRecord(userWorkspacePath: string, apiPath: string): Promise<void> {
  const normalizedApiPath = normalizeApiPath(apiPath);
  if (normalizedApiPath === "/") {
    return;
  }

  try {
    const entries = await readMergedFolderEntries(userWorkspacePath, normalizedApiPath);
    if (entries.length === 0) {
      await recordEmptyFolderPath(userWorkspacePath, normalizedApiPath);
      return;
    }

    await removeEmptyFolderPath(userWorkspacePath, normalizedApiPath);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "PATH_NOT_FOUND") {
      await removeEmptyFolderPath(userWorkspacePath, normalizedApiPath);
      return;
    }

    throw error;
  }
}

function toNoteResponse(apiPath: string, content: string): NoteResponse {
  return {
    path: normalizeApiPath(apiPath),
    content,
    fileVersion: getFileVersion(content)
  };
}

function getParentApiPath(apiPath: string): string {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const parentPath = path.posix.dirname(normalizedApiPath);
  return parentPath === "." ? "/" : parentPath;
}

function getApiPathName(apiPath: string): string {
  const normalizedApiPath = normalizeApiPath(apiPath);
  const index = normalizedApiPath.lastIndexOf("/");
  return normalizedApiPath.slice(index + 1);
}

async function physicalPathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

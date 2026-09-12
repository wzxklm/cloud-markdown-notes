import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config";
import type { Database } from "./db";

type Tool = { name: string; description: string; method: string; path: string; inputSchema: Record<string, unknown> };
const string = (description: string) => ({ type: "string", description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const tools: Tool[] = [
  { name: "tree", description: "Read the complete workspace tree. Use this first when you need to discover note or folder paths.", method: "GET", path: "/api/tree", inputSchema: schema({}) },
  { name: "folder_list", description: "List folders, notes, and files under a workspace path. Paths begin with /. Use tree or this tool to locate content.", method: "GET", path: "/api/folders", inputSchema: schema({ path: string("Folder path beginning with /; defaults to /") }) },
  { name: "folder_create", description: "Create an empty folder. The parent folder must already exist. Empty folders are preserved in version history and exports.", method: "POST", path: "/api/folders", inputSchema: schema({ path: string("New folder path beginning with /") }, ["path"]) },
  { name: "folder_move", description: "Move a folder to a new path. Both paths must begin with /; the destination parent must exist and cannot be inside the source.", method: "PATCH", path: "/api/folders/move", inputSchema: schema({ fromPath: string("Existing folder path"), toPath: string("Destination folder path") }, ["fromPath", "toPath"]) },
  { name: "folder_delete", description: "Delete a folder recursively. This changes the workspace; inspect the tree first and commit afterward if the change should be kept.", method: "DELETE", path: "/api/folders", inputSchema: schema({ path: string("Folder path beginning with /") }, ["path"]) },
  { name: "note_read", description: "Read a Markdown note and its fileVersion. Read before editing so you can preserve the current content and use fileVersion for conflict protection.", method: "GET", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md") }, ["path"]) },
  { name: "note_create", description: "Create a Markdown note. After creating or changing notes, call version_status and version_commit to save a Git history entry.", method: "POST", path: "/api/notes", inputSchema: schema({ path: string("New note path beginning with / and ending in .md"), content: string("Complete Markdown content") }, ["path", "content"]) },
  { name: "note_replace", description: "Replace all content of a Markdown note. Call note_read first and pass its fileVersion as ifMatch; on conflict, read again and retry. Commit afterward when the edit is final.", method: "PUT", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md"), content: string("Complete replacement Markdown content"), ifMatch: string("fileVersion returned by note_read") }, ["path", "content", "ifMatch"]) },
  { name: "note_edit", description: "Replace an inclusive 1-based line range in a Markdown note. Call note_read first and pass its fileVersion as ifMatch; on conflict, read again and retry, then commit the result.", method: "PATCH", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md"), content: string("Replacement text; empty text deletes the selected lines"), fromLine: { type: "integer", minimum: 1, description: "First line, inclusive" }, toLine: { type: "integer", minimum: 1, description: "Last line, inclusive" }, ifMatch: string("fileVersion returned by note_read") }, ["path", "content", "fromLine", "toLine", "ifMatch"]) },
  { name: "note_move", description: "Move a Markdown note. The destination must end in .md. Commit afterward if the move should be recorded.", method: "PATCH", path: "/api/notes/move", inputSchema: schema({ fromPath: string("Existing note path"), toPath: string("Destination note path ending in .md") }, ["fromPath", "toPath"]) },
  { name: "note_delete", description: "Delete a Markdown note. Read or inspect the tree first; commit afterward if the deletion should be kept.", method: "DELETE", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md") }, ["path"]) },
  { name: "search_glob", description: "Find folders and notes by glob. Use this to locate likely paths before note_read. Results are limited and sorted by recent modification.", method: "POST", path: "/api/search/glob", inputSchema: schema({ pattern: string("Glob such as **/*.md"), limit: { type: "integer", minimum: 1, description: "Maximum results" } }, ["pattern"]) },
  { name: "search_grep", description: "Search Markdown note contents. Defaults to literal matching; set regex for regular expressions. Use note_read to inspect a matching note.", method: "POST", path: "/api/search/grep", inputSchema: schema({ pattern: string("Text or regular expression to search"), regex: { type: "boolean", description: "Treat pattern as a regular expression" }, ignoreCase: { type: "boolean", description: "Ignore letter case" }, glob: string("Optional file glob, such as docs/**/*.md"), context: { type: "integer", minimum: 0, description: "Context lines around each match" } }, ["pattern"]) },
  { name: "search_read", description: "Read a selected line range from a Markdown note. Use note_read for the complete document and this tool for targeted inspection.", method: "GET", path: "/api/search/read", inputSchema: schema({ path: string("Note path"), offset: { type: "integer", minimum: 1, description: "First line to return" }, limit: { type: "integer", minimum: 1, description: "Maximum lines to return" } }, ["path"]) },
  { name: "version_status", description: "Show uncommitted workspace changes. Check this before publishing; share_publish requires a clean committed state.", method: "GET", path: "/api/version/status", inputSchema: schema({}) },
  { name: "version_diff", description: "Show the current uncommitted diff so you can review edits before committing.", method: "GET", path: "/api/version/diff", inputSchema: schema({}) },
  { name: "version_commit", description: "Commit all workspace changes with a message. Use after note or folder edits; share_publish requires the target note to be committed.", method: "POST", path: "/api/version/commit", inputSchema: schema({ message: string("Commit message describing the changes") }, ["message"]) },
  { name: "version_history", description: "List commits for the current workspace. Use version_show to inspect a specific commit.", method: "GET", path: "/api/version/history", inputSchema: schema({}) },
  { name: "version_show", description: "Show a commit and its diff. Provide a commit SHA from version_history.", method: "GET", path: "/api/version/show", inputSchema: schema({ commit: string("Commit SHA") }, ["commit"]) },
  { name: "version_discard", description: "Discard all uncommitted changes and restore the workspace to HEAD. Destructive; use version_status and version_diff first.", method: "POST", path: "/api/version/discard", inputSchema: schema({}) },
  { name: "version_restore", description: "Restore a file or folder from a commit. Inspect the result and commit it if the restoration should become current history.", method: "POST", path: "/api/version/restore", inputSchema: schema({ commit: string("Source commit SHA"), path: string("Workspace path to restore"), type: { type: "string", enum: ["file", "folder"], description: "Restore a file or folder" } }, ["commit", "path", "type"]) },
  { name: "share_publish", description: "Publish a Markdown note publicly. Prerequisites: the note is committed and version_status is clean. If not, commit first. Returns the public URL.", method: "POST", path: "/api/shares", inputSchema: schema({ path: string("Committed Markdown note path") }, ["path"]) },
  { name: "share_list", description: "List active public shares owned by the current user, including their URLs.", method: "GET", path: "/api/shares", inputSchema: schema({}) },
  { name: "share_unpublish", description: "Disable an active public share. Get the share id from share_list.", method: "DELETE", path: "/api/shares", inputSchema: schema({ shareId: string("Share id from share_list") }, ["shareId"]) },
  { name: "import_dry_run", description: "Analyze a ZIP archive before importing. Pass its binary contents as base64 in contentBase64; review conflicts before calling import.", method: "POST", path: "/api/import/dry-run", inputSchema: schema({ contentBase64: string("Base64-encoded ZIP archive") }, ["contentBase64"]) },
  { name: "import", description: "Import a ZIP archive after import_dry_run reports no conflicts. Pass binary contents as base64 in contentBase64, then inspect the tree and commit the imported changes.", method: "POST", path: "/api/import", inputSchema: schema({ contentBase64: string("Base64-encoded ZIP archive") }, ["contentBase64"]) }
];

export function registerMcpRoutes(app: FastifyInstance, _config: AppConfig, _db: Database): void {
  app.post("/mcp", async (request, reply) => {
    const body = request.body as { jsonrpc?: string; id?: string | number; method?: string; params?: any };
    const id = body?.id ?? null;
    const result = (r: unknown) => reply.send({ jsonrpc: "2.0", id, result: r });
    if (body?.jsonrpc !== "2.0" || !body.method) return reply.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
    if (body.method === "initialize") return result({ protocolVersion: body.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cloud-markdown-notes", version: "0.3.0" } });
    if (body.method === "notifications/initialized") return reply.status(202).send();
    if (body.method === "tools/list") return result({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (body.method === "tools/call") {
      const name = body.params?.name as string;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return reply.send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
      const args = body.params?.arguments ?? {};
      const headers: Record<string, string> = {};
      const auth = request.headers.authorization; if (auth) headers.authorization = auth;
      const path = buildToolPath(name, tool.path, args);
      let payload: string | Buffer | undefined =
        tool.method === "GET" || tool.method === "DELETE" ? undefined : JSON.stringify(args);
      if (payload !== undefined) headers["content-type"] = "application/json";
      if ((name === "import" || name === "import_dry_run") && typeof args.contentBase64 === "string") {
        payload = Buffer.from(args.contentBase64, "base64");
        headers["content-type"] = "application/zip";
      }
      const response = await app.inject({ method: tool.method, url: path, headers, payload } as any);
      let data: unknown; try { data = JSON.parse(response.body); } catch { data = response.body; }
      return result({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }], isError: response.statusCode >= 400 });
    }
    return reply.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  });
}
function query(args: Record<string, unknown>): string { const entries = Object.entries(args).filter(([,v]) => v !== undefined && typeof v !== "object"); const q = new URLSearchParams(entries.map(([k,v]) => [k, String(v)])); const s = q.toString(); return s ? `?${s}` : ""; }
function buildToolPath(name: string, basePath: string, args: Record<string, unknown>): string {
  if (name === "share_unpublish") return `${basePath}/${encodeURIComponent(String(args.shareId ?? ""))}`;
  if (name === "note_read" || name === "note_replace" || name === "note_edit" || name === "note_delete" || name === "search_read") {
    const paging = name === "search_read" ? query({ offset: args.offset, limit: args.limit }).replace(/^\?/, "&") : "";
    return `${basePath}?path=${encodeURIComponent(String(args.path ?? ""))}${paging}`;
  }
  if (name === "version_show") return `${basePath}?commit=${encodeURIComponent(String(args.commit ?? ""))}`;
  return toolUsesQuery(name) ? basePath + query(args) : basePath;
}
function toolUsesQuery(name: string): boolean {
  return name === "folder_list" || name === "folder_delete" || name === "share_unpublish";
}

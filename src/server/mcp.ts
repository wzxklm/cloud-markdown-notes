import type { FastifyInstance } from "fastify";
import { mcpToolCall } from "./auth";
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
  { name: "folder_delete", description: "Delete the folder and all its contents from the workspace. Inspect the target subtree before deleting.", method: "DELETE", path: "/api/folders", inputSchema: schema({ path: string("Folder path beginning with /") }, ["path"]) },
  { name: "note_read", description: "Read a Markdown note and its fileVersion. Read before editing so you can preserve the current content and use fileVersion for conflict protection.", method: "GET", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md") }, ["path"]) },
  { name: "note_create", description: "Save a new Markdown note in the workspace. Its parent folder must exist and its destination path must be unused.", method: "POST", path: "/api/notes", inputSchema: schema({ path: string("New note path beginning with / and ending in .md"), content: string("Complete Markdown content") }, ["path", "content"]) },
  { name: "note_replace", description: "Overwrite the entire note using the fileVersion of the content you reviewed. On EDIT_CONFLICT, read again and reconcile the replacement with the newer content.", method: "PUT", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md"), content: string("Complete replacement Markdown content"), ifMatch: string("fileVersion returned by note_read") }, ["path", "content", "ifMatch"]) },
  { name: "note_edit", description: "Replace a 1-based inclusive line range using the fileVersion you reviewed. On EDIT_CONFLICT, read again and locate the intended lines in the newer version.", method: "PATCH", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md"), content: string("Replacement text; empty text deletes the selected lines"), fromLine: { type: "integer", minimum: 1, description: "First line, inclusive" }, toLine: { type: "integer", minimum: 1, description: "Last line, inclusive" }, ifMatch: string("fileVersion returned by note_read") }, ["path", "content", "fromLine", "toLine", "ifMatch"]) },
  { name: "note_move", description: "Move or rename a Markdown note. The destination must be an unused .md path in an existing folder.", method: "PATCH", path: "/api/notes/move", inputSchema: schema({ fromPath: string("Existing note path"), toPath: string("Destination note path ending in .md") }, ["fromPath", "toPath"]) },
  { name: "note_delete", description: "Delete one Markdown note from the workspace. Check the target path before deleting.", method: "DELETE", path: "/api/notes", inputSchema: schema({ path: string("Note path beginning with / and ending in .md") }, ["path"]) },
  { name: "search_glob", description: "Find paths matching a glob, newest modifications first. If the result count reaches the limit, narrow the pattern by folder or use tree for a complete inventory.", method: "POST", path: "/api/search/glob", inputSchema: schema({ pattern: string("Glob such as **/*.md"), limit: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Maximum matching paths to return" } }, ["pattern"]) },
  { name: "search_grep", description: "Search Markdown contents by literal text or regex. Returns matching paths and line numbers. Use search_read for a longer passage around a match.", method: "POST", path: "/api/search/grep", inputSchema: schema({ pattern: string("Text or regular expression to search"), regex: { type: "boolean", description: "Treat pattern as a regular expression" }, ignoreCase: { type: "boolean", description: "Ignore letter case" }, glob: string("Optional file glob, such as docs/**/*.md"), context: { type: "integer", minimum: 0, maximum: 10, default: 0, description: "Lines to include on each side of a match" } }, ["pattern"]) },
  { name: "search_read", description: "Read a selected line range from a Markdown note. Use note_read for the complete document and this tool for targeted inspection.", method: "GET", path: "/api/search/read", inputSchema: schema({ path: string("Note path"), offset: { type: "integer", minimum: 1, description: "First line to return" }, limit: { type: "integer", minimum: 1, description: "Maximum lines to return" } }, ["path"]) },
  { name: "version_status", description: "List uncommitted changes across the workspace. Use before commit or discard to check every affected path.", method: "GET", path: "/api/version/status", inputSchema: schema({}) },
  { name: "version_diff", description: "Show the current uncommitted diff so you can review edits before committing.", method: "GET", path: "/api/version/diff", inputSchema: schema({}) },
  { name: "version_commit", description: "Record all current workspace changes in one history entry. Edits are already saved. Review version_status and commit only when the requested task includes all affected paths.", method: "POST", path: "/api/version/commit", inputSchema: schema({ message: string("Commit message describing the changes") }, ["message"]) },
  { name: "version_history", description: "List commits for the current workspace. Use version_show to inspect a specific commit.", method: "GET", path: "/api/version/history", inputSchema: schema({}) },
  { name: "version_show", description: "Show a commit and its diff. Provide a commit SHA from version_history.", method: "GET", path: "/api/version/show", inputSchema: schema({ commit: string("Commit SHA") }, ["commit"]) },
  { name: "version_discard", description: "Discard uncommitted changes across the entire workspace, including untracked files and folders. Review version_status and version_diff before discarding.", method: "POST", path: "/api/version/discard", inputSchema: schema({}) },
  { name: "version_restore", description: "Replace the target file or folder with its contents from the specified commit. Restoring a folder removes current descendants absent from that snapshot. The result is a workspace change.", method: "POST", path: "/api/version/restore", inputSchema: schema({ commit: string("Source commit SHA"), path: string("Workspace path to restore"), type: { type: "string", enum: ["file", "folder"], description: "Restore a file or folder" } }, ["commit", "path", "type"]) },
  { name: "share_publish", description: "Create a public URL for a snapshot of the target Markdown note at HEAD. The target must be committed and have no pending changes. Unrelated drafts can remain. Later edits do not update this link.", method: "POST", path: "/api/shares", inputSchema: schema({ path: string("Committed Markdown note path") }, ["path"]) },
  { name: "share_list", description: "List active public shares owned by the current user, including their URLs.", method: "GET", path: "/api/shares", inputSchema: schema({}) },
  { name: "share_unpublish", description: "Disable an active public share. Get the share id from share_list.", method: "DELETE", path: "/api/shares", inputSchema: schema({ shareId: string("Share id from share_list") }, ["shareId"]) },
  { name: "import_dry_run", description: "Analyze a ZIP archive before importing. Pass its binary contents as base64 in contentBase64; review conflicts before calling import.", method: "POST", path: "/api/import/dry-run", inputSchema: schema({ contentBase64: string("Base64-encoded ZIP archive") }, ["contentBase64"]) },
  { name: "import", description: "Apply the same base64 ZIP inspected by import_dry_run when its plan has no conflicts. Imported notes and folders are saved in the workspace.", method: "POST", path: "/api/import", inputSchema: schema({ contentBase64: string("Base64-encoded ZIP archive") }, ["contentBase64"]) }
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
      const response = await mcpToolCall.run(true, () => app.inject({ method: tool.method, url: path, headers, payload } as any));
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

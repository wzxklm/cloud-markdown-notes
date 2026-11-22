import assert from "node:assert/strict";

const apiBase = process.env.API_BASE_URL ?? "http://app:3000/api";
const mcpUrl = new URL("mcp", apiBase.replace(/api\/?$/, "")).toString();
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin-password";
let requestId = 0;

type RpcResult = {
  serverInfo?: { name: string };
  tools?: { name: string }[];
  content?: { text: string }[];
  isError?: boolean;
};
type RpcResponse = { result?: RpcResult; error?: { code: number; message: string } };

async function rpc(method: string, params: unknown = {}, auth?: string | Record<string, string>): Promise<RpcResponse> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(typeof auth === "string" ? { authorization: `Bearer ${auth}` } : auth)
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params })
  });
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  return (await response.json()) as RpcResponse;
}

async function tool(name: string, args: Record<string, unknown>, auth?: string | Record<string, string>): Promise<RpcResult> {
  const response = await rpc("tools/call", { name, arguments: args }, auth);
  assert.ok(response.result, `Missing result for ${name}`);
  return response.result;
}

function text(result: RpcResult): string {
  return result.content?.[0]?.text ?? "";
}

async function main(): Promise<void> {
  const initialized = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(initialized.result?.serverInfo?.name, "cloud-markdown-notes");

  const listed = await rpc("tools/list");
  const names = new Set((listed.result?.tools ?? []).map((entry: { name: string }) => entry.name));
  for (const name of ["tree", "note_create", "note_read", "search_glob", "version_commit"]) {
    assert.ok(names.has(name), `MCP tool ${name} is missing`);
  }

  const unauthorized = await tool("tree", {});
  assert.equal(unauthorized.isError, true, "Unauthenticated tool call should fail");

  const loginResponse = await fetch(new URL("auth/login", apiBase.endsWith("/") ? apiBase : `${apiBase}/`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  });
  assert.equal(loginResponse.status, 200);
  const login = (await loginResponse.json()) as { data: { token: string } };
  const token = login.data.token;

  const username = "mcp-user-" + Date.now();
  const password = "test:password";
  async function api(path: string, method: string, bearer?: string, body?: unknown) {
    return fetch(apiBase + path, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  const account = { username, password };
  const register = await api("/auth/register", "POST", undefined, account);
  assert.equal(register.status, 201);
  const pending = (await register.json()).data;
  assert.equal((await api("/mcp-keys", "POST", pending.token, { name: "too early" })).status, 401);
  assert.equal((await api("/admin/users/" + pending.user.id + "/activate", "POST", token, {})).status, 200);
  const session = (await (await api("/auth/login", "POST", undefined, account)).json()).data.token;

  async function issue(name: string) {
    const res = await api("/mcp-keys", "POST", session, { name });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return (await res.json()).data as { key: { id: string }; secret: string; linkPath: string };
  }
  const laptop = await issue("Laptop");
  const desktop = await issue("Desktop");
  async function linked(path: string, method: string, params = {}, bearer?: string) {
    return fetch(new URL(path, process.env.WEB_BASE_URL ?? mcpUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params })
    });
  }
  for (const method of ["initialize", "tools/list"]) {
    const response = await linked(laptop.linkPath, method);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).result);
  }
  for (const path of ["/mcp?link=", "/mcp?link=invalid", "/mcp?link=" + laptop.secret, "/mcp?link=" + session]) {
    assert.equal((await linked(path, "initialize")).status, 401);
  }
  assert.equal((await linked(laptop.linkPath, "initialize", {}, token)).status, 401);
  const linkToken = new URL(laptop.linkPath, mcpUrl).searchParams.get("link")!;
  assert.equal((await api("/auth/me", "GET", linkToken)).status, 401);
  assert.equal((await tool("tree", {}, linkToken)).isError, true);
  const list = (await (await api("/mcp-keys", "GET", session)).json()).data.keys;
  assert.equal(list.length, 2);
  assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "id", "name"]);
  assert.equal((await api("/mcp-keys", "POST", laptop.secret, { name: "denied" })).status, 401);
  assert.equal((await api("/auth/me", "GET", laptop.secret)).status, 401);
  assert.equal((await tool("tree", {}, { "X-Notes-Username": username, "X-Notes-Password": password })).isError, true);
  assert.equal((await tool("tree", {}, { authorization: "Basic " + Buffer.from(username + ":" + password).toString("base64") })).isError, true);
  const privateNote = await tool("note_create", { path: "/private.md", content: "user only" }, laptop.secret);
  assert.equal(privateNote.isError, false, text(privateNote));
  assert.equal((await tool("note_read", { path: "/private.md" }, token)).isError, true);
  const readParams = { name: "note_read", arguments: { path: "/private.md" } };
  const own = await linked(laptop.linkPath, "tools/call", readParams);
  assert.match(text((await own.json()).result), /user only/);
  const changed = await linked(laptop.linkPath, "tools/call", { name: "note_create", arguments: { path: "/link.md", content: "written via link" } });
  assert.equal((await changed.json()).result.isError, false);
  assert.equal((await tool("note_read", { path: "/link.md" }, token)).isError, true);
  await api("/mcp-keys/" + laptop.key.id, "DELETE", token);
  assert.match(text(await tool("note_read", { path: "/private.md" }, laptop.secret)), /user only/);
  assert.equal((await api("/mcp-keys/" + laptop.key.id, "DELETE", session)).status, 200);
  assert.equal((await tool("tree", {}, laptop.secret)).isError, true);
  assert.equal((await linked(laptop.linkPath, "tools/call", readParams)).status, 401);
  assert.equal((await linked(desktop.linkPath, "tools/call", readParams)).status, 200);
  assert.equal((await api("/auth/logout", "POST", session, {})).status, 200);
  assert.match(text(await tool("note_read", { path: "/private.md" }, desktop.secret)), /user only/);

  const path = `/mcp-${Date.now()}.md`;
  const created = await tool("note_create", { path, content: "# MCP test\n" }, token);
  assert.match(text(created), /MCP test/);
  const read = await tool("note_read", { path }, token);
  assert.match(text(read), /MCP test/);
  const search = await tool("search_grep", { pattern: "MCP test" }, token);
  assert.match(text(search), /MCP test/);
  await tool("version_commit", { message: "MCP test commit" }, token);

  const unknown = await rpc("tools/call", { name: "missing_tool", arguments: {} }, token);
  assert.equal(unknown.error?.code, -32602);
  console.log("[mcp-test] passed");
}

await main();

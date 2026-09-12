import assert from "node:assert/strict";

const apiBase = process.env.API_BASE_URL ?? "http://app:3000/api";
const mcpUrl = new URL("mcp", apiBase.replace(/api\/?$/, "")).toString();
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin-password";
let requestId = 0;

type RpcResponse = { result?: any; error?: { code: number; message: string } };

async function rpc(method: string, params: unknown = {}, token?: string): Promise<RpcResponse> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params })
  });
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  return (await response.json()) as RpcResponse;
}

async function tool(name: string, args: Record<string, unknown>, token?: string): Promise<any> {
  const response = await rpc("tools/call", { name, arguments: args }, token);
  assert.ok(response.result, `Missing result for ${name}`);
  return response.result;
}

function text(result: any): string {
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

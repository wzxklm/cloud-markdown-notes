## Create a key

Sign in to the Notes workspace, open **MCP keys**, enter a name for this client, and choose **Create MCP key**. Use a separate key for each client. The key and its private ChatGPT connection URL are shown only at creation.

## ChatGPT on the web

Choose **Copy ChatGPT link**. In ChatGPT, add a custom MCP connector, paste the entire link into **MCP server URL**, and select **No authentication**. Anyone with the link can read and edit your notes. If you no longer have the link or your key predates this feature, create a new key.

## Clients with a Bearer token field

Choose **Streamable HTTP** and enter `https://notes.example.com/mcp` as the server URL. In a **Bearer token** field, paste just the key. If your client takes HTTP headers, set `Authorization` to `Bearer ` followed by the key. This connection works independently of the Notes CLI.

For Codex, add the following entry to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`). If an entry named `cloud-notes` already exists, edit that entry. Replace the placeholder locally.

```toml
[mcp_servers.cloud-notes]
url = "https://notes.example.com/mcp"
http_headers = { Authorization = "Bearer YOUR_MCP_KEY" }
```

Keep the configuration file private and reload your client after saving.

## Verify and revoke

Ask your assistant to use the cloud-notes `folder_list` tool to list `/`. An empty list is a successful response for an empty workspace. The key grants access to your own notes while your account has workspace access.

To disconnect a device, open **MCP keys** in Notes and choose **Revoke** for its key. This disables both the key and its connection link. In Codex, you can also remove the local entry with `codex mcp remove cloud-notes`.

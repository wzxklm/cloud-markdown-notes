# Cloud Markdown Notes

**English** · [简体中文](README.zh-CN.md)

Cloud Markdown Notes is a self-hosted Markdown service with a separate workspace for each user. Write in the browser, organize notes from the terminal, or connect an AI assistant over MCP to search and edit the same files.

[Open Notes](https://notes.bosschat.de) · [Self-hosting guide](docs/self-hosting.md) · [MIT license](LICENSE)

## Notes and version history

- **Organize and search.** Use nested folders, preview Markdown, find paths by glob, search note contents, and read selected lines.
- **Commit and share.** Save drafts as you work, review the diff, and commit when ready. Restore individual files or folders. Publish a link to a committed version of a note once that note has no pending changes. Other notes can still have drafts.
- **Import and export.** Preview a ZIP import to check for conflicts. Exports include Markdown files and folders, including empty folders.

## Connect to your workspace

| Interface | Getting started |
| --- | --- |
| Web | Sign up or log in at [Notes](https://notes.bosschat.de). An administrator can activate a new account, or users can subscribe on an instance with billing enabled. |
| CLI | Install Node.js 18 or later, set your instance URL, and log in. See the [CLI guide](packages/cli/README.md) and the [CLI skill for AI assistants](docs/skills/cloud-notes-cli/SKILL.md). |
| MCP | Create a personal MCP key in your workspace and use its private connection URL in ChatGPT, or use the key as a Bearer token at `/mcp`. See the [MCP connection guide](docs/connect-notes-mcp.md). |
| HTTP API | Use a session bearer token with the notes, search, version, and sharing endpoints under `/api`. Supply the file version you read when editing to detect concurrent changes. See the [feature and API reference (Chinese)](docs/可测试功能.md). |

## Self-hosting and billing

Both deployment methods use the same Docker Compose configuration and data directories.

- [Deploy a published image](docs/self-hosting.md#deploy-a-published-image) to run a Docker Hub release with its matching configuration files.
- [Build from source](docs/self-hosting.md#build-from-source) to deploy a specific commit or your own changes.

Stripe billing is optional. When enabled, users can subscribe for **HK$10 per month** or top up their wallet with a one-time payment of **HK$10–1,000** in whole dollars. A top-up credits the wallet. Monthly deductions start only when the user enables balance renewal. See [Stripe sandbox setup](docs/self-hosting.md#stripe-sandbox-setup) for configuration and verification.

## Development and testing

Run these Bash commands from the repository root:

```bash
export HOST_API_PORT=127.0.0.1:18082 HOST_WEB_PORT=127.0.0.1:15173
export HOST_DATA_ROOT=./runtime/dev
dev=(docker compose --env-file .env.dev --project-directory "$PWD" -f docker/compose.yml -p notes-dev)
"${dev[@]}" up -d --build --wait app db
"${dev[@]}" exec app npm run lint
"${dev[@]}" exec app npm run build
```

The source is mounted at `/app`. Open the [local web interface](http://127.0.0.1:15173) or check [API health](http://127.0.0.1:18082/api/health). Run `"${dev[@]}" down` in the same shell to stop the development environment.

Run `sh tests/run-e2e.sh` on the host to start the isolated `notes-test` environment and run the billing, API, CLI, MCP, and browser tests. The suite resets its test database and workspace. Use dedicated test data. Reports are written to `runtime/fulltest-docker/`.

For the official hosted instance, see the [production runbook](docs/production-operations.md).

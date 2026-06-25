---
name: cloud-notes-cli
description: "Use when Codex needs to operate Cloud Markdown Notes through the `notes` CLI: install or update the CLI, configure API URL/auth, inspect or edit notes, commit/restore versions, import/export/share, parse JSON output, or recover from CLI/API errors."
---

# Cloud Notes CLI

This skill gives Codex the minimum operating procedure for using the Cloud Markdown Notes `notes` CLI without loading a full command manual. For exact syntax, run `notes help`.

## Install Or Update

Install or update the published CLI:

```bash
npm install -g cloud-markdown-notes@latest
```

Use the public command:

```bash
notes <command>
```

Do not edit CLI config files directly. Configure the CLI through `notes config`, `notes auth`, global flags, or environment variables.

## Configure And Authenticate

Set the target server and check it before doing work:

```bash
notes config set-api-url <server-url>
notes config get
notes health --json
```

For one-off commands, pass the URL or token explicitly:

```bash
notes --api-url <server-url> health --json
notes --token <token> auth me --json
```

Prefer login for normal sessions:

```bash
notes auth login <username> <password>
notes auth me --json
```

If a user is pending, log in as an admin, inspect pending users, and activate the intended user:

```bash
notes admin pending-users --json
notes admin activate <user-id>
```

## Output Rules

Use `--json` whenever Codex will parse, assert, or reuse command output:

```bash
notes tree --json
notes status --json
notes history --json
```

Successful JSON responses are wrapped in `data`; failures are wrapped in `error` with `code` and `message`.

Human-readable output is acceptable for inspection-heavy commands such as `notes help`, `notes diff`, and `notes show <sha>`.

Quote paths, globs, regexes, and Markdown strings that may contain shell metacharacters. Workspace paths start with `/`; notes are Markdown files ending in `.md`.

## Agent Workflow

Use this sequence unless the user asks for a narrower operation:

1. Confirm the target server: `notes config get` or `notes --api-url <url> ...`.
2. Check health: `notes health --json`.
3. Authenticate and verify identity: `notes auth login ...`, then `notes auth me --json`.
4. Inspect state before mutating: `notes tree --json`, `notes status --json`, and, for version tasks, `notes history --json`.
5. Read before editing: use `notes note read <path> --json` for full files or `notes search read <path> --offset <n> --limit <n> --json` for a slice.
6. Make the smallest command that satisfies the task.
7. Re-check state with `notes status --json`, relevant reads/searches, or `notes diff`.
8. Commit only when requested or clearly part of the workflow: `notes commit -m "<message>" --json`.

## Common Task Patterns

Create or inspect content:

```bash
notes folder mkdir /docs
notes note create /docs/a.md --content "# A" --json
notes note read /docs/a.md --json
notes tree --json
```

Edit content:

```bash
notes note replace /docs/a.md --content "# Updated" --json
notes note edit /docs/a.md --from-line 10 --to-line 12 --content "Replacement" --json
notes note mv /docs/a.md /docs/b.md --json
notes note rm /docs/b.md --json
```

Find content and read context:

```bash
notes search glob "**/*.md" --json
notes search grep "target text" --ignore-case --json
notes search read /docs/a.md --offset 1 --limit 40 --json
```

Manage versions:

```bash
notes status --json
notes diff
notes commit -m "save notes" --json
notes history --json
notes show <sha>
notes restore --commit <sha> --path /docs/a.md --type file --json
notes discard --json
```

Import, export, and share:

```bash
notes export -o notes.zip
notes import notes.zip --dry-run --json
notes import notes.zip --json
notes share publish /docs/a.md --json
notes share list --json
notes share unpublish <share-id> --json
```

## Guardrails

Run `notes help` when command syntax is uncertain instead of guessing.

Before destructive or broad operations, verify the active user, target path, and current status. This applies especially to `note rm`, `folder rm`, `discard`, `restore`, and non-dry-run `import`.

For focused edits, prefer `search grep` plus `search read` to find exact line ranges, then use `note edit`.

For imports, run `notes import <zip> --dry-run --json` first and inspect conflicts before applying.

For shares, commit the note and ensure the workspace is clean before publishing.

## Error Recovery

Use `error.code` to choose the next step:

- `UNAUTHENTICATED`: log in again or pass `--token` for a one-off command.
- `USER_PENDING`: activate the user as admin.
- `FORBIDDEN`: switch to an account with permission.
- `VALIDATION_ERROR`: re-check command syntax with `notes help` and validate paths.
- `PATH_NOT_FOUND`: inspect `notes tree --json` and create or correct the parent path.
- `PATH_ALREADY_EXISTS`: choose another path or remove/move the existing item intentionally.
- `EDIT_CONFLICT`: re-read the note, then retry with the current version or omit `--if-match`.
- `NO_CHANGES_TO_COMMIT`: inspect `notes status --json`; do not retry commit unchanged.
- `IMPORT_CONFLICT`: rerun dry-run and inspect conflict paths.
- `NOTE_NOT_COMMITTED`: commit the note before publishing a share.

---
name: cloud-notes-cli
description: Operate Cloud Markdown Notes through the notes CLI to inspect or edit notes, manage versions, import/export, or share content. Use for this CLI, not generic Markdown editing or VPS administration.
---

# Cloud Notes CLI

Use the existing `notes` client and run `notes help` for exact syntax. Install or upgrade only when needed for the user's task; do not automatically update to latest. Respect local development-container requirements when installing tools on a managed VPS.

## Target and authentication

```bash
notes config get --json
notes --api-url '<server-url>' health --json
notes auth me --json
```

Respect the user's selected server. URL precedence is `--api-url` → `NOTES_API_URL` → config → localhost:8080; token precedence is `--token` → `NOTES_TOKEN` → config. Do not assume the default localhost port is the intended service.
Use CLI configuration commands, flags or environment variables rather than editing config files directly. Keep separate config paths with `NOTES_CONFIG_PATH` when switching accounts or environments.

Prefer an existing authorized session. When login is needed, `notes auth login '<username>' '<password>'` stores the session. Do not expose passwords in tool transcripts. Avoid `--json` on login because its response contains the session token; also treat registration JSON as potentially credential-bearing. Do not print config-file contents or tokens. `config get` reports tokenConfigured without revealing the token.

A pending account is not permission to activate it or switch to administrator credentials. Activate a specified account only when that operation is within the user's authorized task.

## Read and modify

For a narrow task, inspect only the relevant state; do not force a full workflow. Before changing a note, read it and locate the exact lines. Use `--json` when parsing non-secret output; success is wrapped in data and failures in error with code/message.

```bash
notes tree --json
notes search grep "target" --json
notes search read /docs/a.md --offset 1 --limit 40 --json
notes note read /docs/a.md --json
notes note edit /docs/a.md --from-line 10 --to-line 12 --json <<'MARKDOWN'
Replacement
MARKDOWN
notes note replace /docs/a.md --json < updated.md
```

Workspace paths begin with `/`; notes end with `.md`. Quote paths/globs/regexes containing shell metacharacters. Create/replace/edit take content only from stdin; use a quoted heredoc or file input. Empty stdin deletes the selected range for edit. Line ranges are 1-based and inclusive.

The CLI normally fetches the current fileVersion; `--if-match` explicitly supplies it. For EDIT_CONFLICT, re-read and reconcile the change before retrying. Verify the resulting read or diff; do not overwrite another change blindly.

## Versions, imports and sharing

```bash
notes status --json
notes diff
notes history --json
notes show '<sha>'
notes import notes.zip --dry-run --json
notes share list --json
```

- Commit only when requested or clearly included in the task. Do not add a commit to every text edit.
- Before rm, discard, restore or a writing import, verify the account, path and affected state. Use the existing user authorization; ask only when scope is unclear.
- Inspect import dry-run conflicts before the actual import. Do not delete conflicting data merely to make import succeed.
- Public sharing requires a committed note and clean workspace; publish only when requested. Do not commit unrelated drafts to satisfy the precondition.
- Exported ZIP files contain notes/folders, not a complete account/database/Git backup.

For UNAUTHENTICATED, use an authorized login; for USER_PENDING or FORBIDDEN, explain the access requirement without escalating privileges automatically. For PATH_NOT_FOUND/PATH_ALREADY_EXISTS, inspect and correct the intended path. For NO_CHANGES_TO_COMMIT, stop retrying unchanged state. Use `notes help` for unknown flags instead of guessing.

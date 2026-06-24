---
name: cloud-notes-cli
description: "Teach an AI coding agent how to use the npm-installed Cloud Markdown Notes `notes` CLI. Use when an agent needs to operate the notes service through the CLI entrypoint: configure the API URL, log in, inspect health, manage folders and Markdown notes, commit and restore versions, search content, import/export zip archives, publish shares, use JSON output, or handle CLI/API errors."
---

# Cloud Notes CLI

This skill teaches an AI agent to operate Cloud Markdown Notes through the npm-installed `notes` CLI.

## Install And Entry Point

Install the CLI from npm:

```bash
npm install -g cloud-markdown-notes
```

Always invoke the CLI through the public command:

```bash
notes <command>
```

Do not edit config files directly. Configure and inspect CLI state only through `notes config`, `notes auth`, and normal command flags.

## First Run

Point the CLI at the server:

```bash
notes config set-api-url http://localhost:8080
```

Confirm the configured endpoint:

```bash
notes config get
```

Check server health:

```bash
notes health --json
```

For a one-off command against another server, use the CLI flag:

```bash
notes --api-url https://notes.example.com health --json
```

## JSON Output

Use `--json` whenever the output will be parsed, asserted, or reused by an agent:

```bash
notes tree --json
```

Successful JSON output is wrapped in `data`. Failed JSON output uses:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

Human-readable output is useful for manual inspection commands such as `notes help` and `notes diff`.

## Authentication

Register a user:

```bash
notes auth register alice alice-password
```

Log in:

```bash
notes auth login alice alice-password
```

Login saves the active server URL and session token for later `notes` commands.

Verify the current user:

```bash
notes auth me --json
```

Log out:

```bash
notes auth logout
```

New users are created as pending users. An admin must activate them before they can log in:

```bash
notes auth login admin change-me
notes admin pending-users --json
notes admin activate <user-id>
```

## Folders And Tree

Workspace paths must start with `/`.

Create and inspect folders:

```bash
notes folder mkdir /docs
notes folder ls /docs --json
notes tree --json
```

Move or delete folders:

```bash
notes folder mv /docs /archive/docs
notes folder rm /archive/docs
```

## Notes

Notes must be Markdown files with the `.md` extension.

Create notes:

```bash
notes note create /docs/a.md --content "# A"
notes note create /docs/b.md --file local.md
```

Read a note:

```bash
notes note read /docs/a.md --json
```

Replace a note:

```bash
notes note replace /docs/a.md --content "# Updated"
notes note replace /docs/a.md --file local.md
```

`note replace` automatically reads the current file version when `--if-match` is omitted. Use `--if-match <fileVersion>` only when explicitly testing conflict behavior.

Move or delete notes:

```bash
notes note mv /docs/a.md /docs/c.md
notes note rm /docs/c.md
```

## Versioning

Inspect pending changes:

```bash
notes status --json
notes diff
```

Commit all current workspace changes:

```bash
notes commit -m "save notes" --json
```

View history:

```bash
notes history --json
```

View one commit's details and patch:

```bash
notes show <sha>
notes show <sha> --json
```

Discard uncommitted changes:

```bash
notes discard
```

Restore a note or folder from a commit:

```bash
notes restore --commit <sha> --path /docs/a.md --type file
notes restore --commit <sha> --path /docs --type folder
```

## Search And Partial Read

Find paths by glob:

```bash
notes search glob "**/*.md" --json
```

Find content by fixed string:

```bash
notes search grep "todo" --ignore-case --glob "docs/**/*.md" --json
```

Find content by regex:

```bash
notes search grep "TODO|FIXME" --regex --json
```

Read a note slice by line range:

```bash
notes search read /docs/a.md --offset 1 --limit 20 --json
```

Supported search flags:

- `notes search glob`: `--pattern`, `--glob`, `--limit`
- `notes search grep`: `--pattern`, `--regex`, `--ignore-case`, `--glob`, `--context`
- `notes search read`: `--path`, `--offset`, `--limit`

Quote shell-sensitive globs, regexes, paths, and Markdown strings.

## Import And Export

Export the current workspace as a zip:

```bash
notes export -o notes.zip
```

Preview a zip import without writing:

```bash
notes import notes.zip --dry-run --json
```

Import a zip:

```bash
notes import notes.zip --json
```

Imports preserve Markdown files and folders, including empty folders. Conflicts cause the import to fail instead of partially applying.

## Sharing

A note must be committed and the workspace must be clean before publishing a share.

```bash
notes share publish /docs/a.md --json
notes share list --json
notes share unpublish <share-id>
```

Published share output includes `id`, `slug`, `url`, `notePath`, and `commitSha`.

## Help

Use the built-in help when uncertain:

```bash
notes help
```

Global options:

```bash
notes --api-url <url> <command>
notes --token <token> <command>
notes <command> --json
```

Use `--token` only for an explicit one-off command. Prefer `notes auth login` for normal sessions.

## Common Errors

Use these codes to decide the next command:

- `UNAUTHENTICATED`: run `notes auth login ...` or pass `--token` for a one-off command.
- `FORBIDDEN`: current user lacks permission, often admin-only command.
- `USER_PENDING`: log in as admin and activate the user.
- `VALIDATION_ERROR`: command arguments or path format are invalid.
- `PATH_NOT_FOUND`: create the parent folder or correct the path.
- `PATH_ALREADY_EXISTS`: choose another path or remove the existing item.
- `EDIT_CONFLICT`: re-read the note, then retry with the current file version.
- `NO_CHANGES_TO_COMMIT`: there is nothing to commit.
- `IMPORT_CONFLICT`: run `notes import <zip> --dry-run --json` and inspect conflicts.
- `NOTE_NOT_COMMITTED`: commit the note before publishing a share.
- `SHARE_NOT_FOUND`: the share id or slug is invalid or inactive.

## Agent Workflow

Use this sequence for reliable CLI operation:

1. Run `notes config set-api-url <server-url>`.
2. Run `notes health --json`.
3. Log in with `notes auth login <username> <password>`, or register and ask/admin-activate if needed.
4. Verify identity with `notes auth me --json`.
5. Inspect state with `notes tree --json`, `notes status --json`, and `notes history --json`; use `notes show <sha> --json` for a specific commit's details and patch.
6. Run mutating commands only after the target path and active user are clear.
7. Prefer `--json` for machine-readable outputs and parse `data` or `error`.
8. Quote every path, glob, regex, and Markdown string that may contain shell metacharacters.

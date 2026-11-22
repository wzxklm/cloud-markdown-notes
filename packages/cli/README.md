# Cloud Markdown Notes CLI

Standalone client; Node.js 18+ is required. Package version and executable are defined in [package.json](package.json). It does not install the API, database or Web UI.

## Connect

Install a chosen published version on the client, or use the `notes` command in the project's development container:

```bash
npm install -g 'cloud-markdown-notes@<version>'
notes config set-api-url https://notes.bosschat.de
notes health --json
notes auth login '<username>' '<password>'
notes auth me --json
```

Replace placeholders in a private terminal. Login takes a password argument; do not put real credentials in shared command transcripts. Human-readable login saves the session without printing its token; **login with `--json` includes the token** and must not be logged.

Config defaults to `~/.config/cloud-markdown-notes/config.json`; override with `NOTES_CONFIG_PATH`. URL precedence: `--api-url` → `NOTES_API_URL` → config → `http://localhost:8080`. Token precedence: `--token` → `NOTES_TOKEN` → config. Set the HTTPS URL of your own Notes instance or use the hosted service shown above.

## Read and edit

```bash
notes tree --json
notes folder mkdir /docs
notes note create /docs/a.md < local.md
notes note read /docs/a.md --json
notes search grep "target" --json
notes search read /docs/a.md --offset 1 --limit 40 --json
notes note replace /docs/a.md < updated.md
notes note edit /docs/a.md --from-line 10 --to-line 12 <<'MARKDOWN'
Replacement
MARKDOWN
```

Create, replace and edit read Markdown only from stdin. Quote heredoc delimiters to prevent shell expansion. Empty stdin is valid; for edit it deletes the selected range. Edit uses 1-based inclusive line ranges. Replace/edit fetch the current fileVersion unless `--if-match` is supplied; after a conflict re-read before retrying.

## Versions and transfer

```bash
notes status --json
notes diff
notes commit -m "save notes"
notes history --json
notes show '<sha>'
notes restore --commit '<sha>' --path /docs/a.md --type file
notes import notes.zip --dry-run --json
notes export -o notes.zip
notes share list --json
```

Commit, restore, discard, deletion, import and public sharing change user data or visibility: use them only for the requested operation. Import dry-run does not write data; publishing requires the target note to match its committed version. Other paths can have pending changes. ZIP export does not back up database metadata or Git history.

`notes help` contains the full command syntax. JSON success is wrapped in data and failure in error; version status/diff preserve non-ASCII filenames. See [server README](../../README.md) for deployment and [the skill](../../docs/skills/cloud-notes-cli/SKILL.md) for agent constraints.

# Cloud Markdown Notes CLI

Command-line client for a Cloud Markdown Notes server.

## Install

```bash
npm install -g cloud-markdown-notes
```

## Configure

```bash
notes config set-api-url https://notes.example.com
notes auth login alice alice-password
notes health
```

You can also pass the server URL for a single command:

```bash
notes --api-url https://notes.example.com health
```

Configuration is stored at `~/.config/cloud-markdown-notes/config.json` by default.
Set `NOTES_CONFIG_PATH` to use a different config file.

## Notes

```bash
notes note create /docs/a.md < local.md
notes note read /docs/a.md
notes note replace /docs/a.md <<'MARKDOWN'
# Updated
MARKDOWN
notes note edit /docs/a.md --from-line 10 --to-line 12 <<'MARKDOWN'
Replacement
MARKDOWN
notes note edit /docs/a.md --from-line 10 --to-line 12 < /dev/null
notes note mv /docs/a.md /docs/b.md
notes note rm /docs/b.md
```

`note create`, `note replace`, and `note edit` read Markdown content only from stdin. Use input redirection, a pipe, or a quoted heredoc (`<<'MARKDOWN'`) so the shell does not interpret Markdown characters. Empty stdin is valid content; with `note edit`, it deletes the selected line range.

`note edit` performs a 1-based inclusive line-range replacement. It automatically reads the current `fileVersion` unless `--if-match <fileVersion>` is passed for explicit conflict testing.

## Versioning

```bash
notes status
notes diff
notes commit -m "save notes"
notes history
notes show <sha>
notes restore --commit <sha> --path /docs/a.md --type file
```

Versioning status and patch diff output preserve non-ASCII paths as their original filenames.

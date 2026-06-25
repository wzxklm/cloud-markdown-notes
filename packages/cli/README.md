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
notes note create /docs/a.md --content "# A"
notes note read /docs/a.md
notes note replace /docs/a.md --content "# Updated"
notes note edit /docs/a.md --from-line 10 --to-line 12 --content "Replacement"
notes note edit /docs/a.md --from-line 10 --to-line 12 --content ""
notes note mv /docs/a.md /docs/b.md
notes note rm /docs/b.md
```

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

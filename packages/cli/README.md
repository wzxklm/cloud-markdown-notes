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

## Versioning

```bash
notes status
notes diff
notes commit -m "save notes"
notes history
notes show <sha>
notes restore --commit <sha> --path /docs/a.md --type file
```

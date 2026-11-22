# Official hosted instance operations

**English** · [简体中文](production-operations.zh-CN.md)

The official instance runs the `app` and `db` services under the Compose project `notes-prod`. It uses `docker/compose.prod.yml` and `.env.prod`. The API listens on `127.0.0.1:18081` and the web service on `127.0.0.1:5173`. PostgreSQL 16 has no published host port.

Keep `--project-directory /root/notes/docker` in all production commands. Compose resolves relative data mounts against that directory. Changing it to `/root/notes` can point the services at an empty database.

```bash
cd /root/notes
dc=(docker compose --project-directory /root/notes/docker --env-file /root/notes/.env.prod -f /root/notes/docker/compose.prod.yml -p notes-prod)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait --pull never
"${dc[@]}" ps
curl -fsS http://127.0.0.1:18081/api/health
```

In the same Bash shell, use `"${dc[@]}" logs --tail 100` to inspect logs, `"${dc[@]}" stop -t 90` to stop the services, `"${dc[@]}" up -d --wait --pull never` to bring them back up, or `"${dc[@]}" restart` to restart them.

| Data | Path relative to the repository root |
| --- | --- |
| PostgreSQL | `docker/runtime/prod/postgres/` |
| Workspaces, Git history, and folder metadata | `docker/runtime/prod/workspaces/` |
| Credentials, public URL, and Stripe settings | `.env.prod` |
| Image and database backups | `backups/` |

The application image is `local/notes:billing-selfhost-20261122`. Production Compose also pins the database image and sets `pull_policy: never` for both services. To restore the images, load the application archive at `backups/billing-selfhost-20261122T084347Z/release-image.tar.gz` and the database image from `backups/mcp-keys-20261122T062724Z/rollback-images.tar.gz` using `gzip -dc <archive> | docker image load`. Take a consistent backup before updating the Compose image reference.

Startup runs database migrations before the API and web services. The web service proxies `/api/*` and `/mcp` to the API and serves the SPA entry point for client-side routes.

Keep production credentials in the private `.env.prod` file. Preserve it when updating from the example. The instance uses `PROD_HOST_API_PORT=18081`, `PROD_HOST_WEB_PORT=5173`, and `PUBLIC_BASE_URL=https://notes.bosschat.de`. The Nginx site manifest is `/root/nginx/sites.json` and the generated configuration is `/root/nginx/config/conf.d/notes.conf`.

For a host migration, prepare Nginx, DNS, certificates, and firewall settings as well as the application data. The VPS backup procedure is in `/root/README.md` on the host.

## Backup and recovery

Stop application writes before taking a database backup with `pg_dump -Fc`. Archive the workspaces, including hidden files, Git history and folder metadata, together with the private environment file and deployed Compose file. To copy PostgreSQL's data directory directly, shut the database down cleanly first. Use mode 700 for backup directories and 600 for files containing credentials.

To recover, stop the application and extract the workspace archive into an empty directory, preserving numeric user and group IDs. Use `pg_restore` to load a logical backup into an empty database. Verify the domain, credentials, images, and mounts before starting Compose and checking health.

Before rollback, preserve orders, ledger entries, and refund revocations recorded since the upgrade. If new payments have arrived, stop writes and reconcile the ledger before choosing a compatible image. The version must understand wallet entitlements and `refunded_card_subscriptions` so it does not grant access again for refunded subscriptions.

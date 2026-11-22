# 官方托管实例运维

[English](production-operations.md) · **简体中文**

Compose：`docker/compose.prod.yml`；环境：`.env.prod`；项目名：`notes-prod`；服务：`app`、`db`。API 为 `127.0.0.1:18081`，Web 为 `127.0.0.1:5173`，PostgreSQL 16 不发布主机端口。

**所有生产命令必须保持下面的项目目录。** 它决定相对挂载路径，改为 `/root/notes` 可能连接一个新的空数据库。

```bash
cd /root/notes
dc=(docker compose --project-directory /root/notes/docker --env-file /root/notes/.env.prod -f /root/notes/docker/compose.prod.yml -p notes-prod)
"${dc[@]}" config --quiet
"${dc[@]}" up -d --wait --pull never
"${dc[@]}" ps
curl -fsS http://127.0.0.1:18081/api/health
```

同一 Bash 会话中，查看日志用 `"${dc[@]}" logs --tail 100`，停止用 `"${dc[@]}" stop -t 90`，恢复用 `"${dc[@]}" up -d --wait --pull never`，重启用 `"${dc[@]}" restart`。

| 数据 | 主机位置 |
| --- | --- |
| PostgreSQL | `docker/runtime/prod/postgres/` |
| 用户笔记、Git 历史、目录元数据 | `docker/runtime/prod/workspaces/` |
| 凭据、外部地址、Stripe 配置 | `.env.prod` |
| 镜像和数据库备份 | `backups/` |

应用镜像为 `local/notes:cli-url-20261122`，数据库镜像由生产 Compose 固定，两者均为 `pull_policy: never`。恢复时，应用镜像从 `backups/cli-url-20261122T165755Z/release-image.tar.gz` 导入，数据库镜像从 `backups/mcp-keys-20261122T062724Z/rollback-images.tar.gz` 导入，命令为 `gzip -dc <归档路径> | docker image load`。升级前执行一致性备份，再显式修改 Compose 的 `image`。
生产启动会执行数据库迁移，再启动 API/Web。Web 将 `/api/*` 和 `/mcp` 代理到 API，其他页面使用 SPA fallback。

生产凭据只存 `.env.prod`；不要从 example 覆盖。`PROD_HOST_API_PORT=18081`、`PROD_HOST_WEB_PORT=5173`，`PUBLIC_BASE_URL=https://notes.bosschat.de`。Nginx 清单见 `/root/nginx/sites.json`，生成站点为 `/root/nginx/config/conf.d/notes.conf`。

迁移时同时准备 Nginx、DNS、证书和防火墙设置。主机通用备份流程见 VPS 上的 `/root/README.md`。以下相对路径以项目根目录为准。

## 备份与恢复

先停止应用写入，再用 `pg_dump -Fc` 备份数据库，同时归档工作区（包括隐藏文件、Git 历史和目录元数据）、私有环境文件与实际使用的 Compose 文件。若复制 PostgreSQL 数据目录，先干净停止数据库。备份目录权限为 700，含凭据的文件为 600。

恢复时停止应用，将工作区解包到空目录并保留数值 UID/GID。逻辑备份用 `pg_restore` 导入空数据库。核对域名、凭据、镜像和挂载后，按上面的 Compose 命令启动并检查健康状态。

回退前保留升级后新增的订单、账本流水与退款撤权记录。已有新收款时，先停止写入、对账并评估镜像与数据的兼容性。使用能识别余额权限和 `refunded_card_subscriptions` 的版本，防止重复授予已退款的订阅权限。

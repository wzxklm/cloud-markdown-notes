# Cloud Markdown Notes

云端 Markdown 笔记系统，提供同一套笔记能力的 API、CLI 和 Web UI 三端入口。

当前能力：

- 用户注册、登录、退出、会话校验，以及管理员激活普通用户。
- 每个用户独立 workspace，普通用户最多 1000 篇 `.md` 笔记，管理员不受该限制。
- 文件夹和 Markdown 笔记的创建、读取、编辑、移动、删除；空文件夹会通过 `.notes-meta/folders.json` 保留。
- 笔记编辑使用 `fileVersion` 和 `ifMatch` 做并发冲突保护。
- Git 风格版本管理：`status`、`diff`、`commit`、`history`、`discard`、`restore`。
- Glob、Grep、Read 检索，仅面向工作区内的 Markdown 笔记和文件夹。
- zip 导入、dry-run 冲突检查和 zip 导出。
- 单篇已提交笔记公开分享；分享固定到发布时的 commit，取消发布或删除已提交文件后失效。
- 独立 npm CLI 包：`cloud-markdown-notes`，包内只包含命令行客户端。

## 运行环境

Docker 开发、测试和部署需要：

- Docker
- Docker Compose

宿主机直接运行仓库开发命令时，还需要：

- Node.js 24+
- Git

只安装已发布 CLI 包时，Node.js 18+ 即可。

## 环境变量

开发环境可从示例复制：

```bash
cp .env.example .env
```

常用变量：

```text
APP_ENV=development
API_PORT=3000
WEB_PORT=5173
HOST_API_PORT=8080
HOST_WEB_PORT=5173

POSTGRES_USER=notes
POSTGRES_PASSWORD=notes
POSTGRES_DB=notes
DATABASE_URL=postgres://notes:notes@db:5432/notes

WORKSPACE_ROOT=/data/workspaces
HOST_DATA_ROOT=./runtime/dev
PUBLIC_BASE_URL=http://localhost:5173
NOTES_API_URL=http://localhost:8080

SESSION_SECRET=change-me
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

说明：

- `API_PORT` 和 `WEB_PORT` 是容器内端口。
- `HOST_API_PORT` 和 `HOST_WEB_PORT` 是开发环境暴露到宿主机的端口。
- `WORKSPACE_ROOT` 是容器内 workspace 路径，宿主机数据落在 `HOST_DATA_ROOT`。
- `PUBLIC_BASE_URL` 用于生成公开分享链接。
- `NOTES_API_URL` 是 CLI 默认连接的服务端地址。

生产环境参考 `.env.prod.example`：

```bash
cp .env.prod.example .env.prod
```

生产环境至少修改：

- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `ADMIN_PASSWORD`
- `PUBLIC_BASE_URL`

生产端口和数据目录由以下变量控制：

```text
PROD_HOST_API_PORT=8080
PROD_HOST_WEB_PORT=5173
PROD_HOST_DATA_ROOT=./runtime/prod
```

## 开发运行

启动 Docker 开发服务：

```bash
docker compose --project-directory . -f docker/compose.yml up -d app db
```

默认访问：

- API: `http://localhost:8080/api`
- Web UI: `http://localhost:5173`

查看日志：

```bash
docker compose --project-directory . -f docker/compose.yml logs -f app
```

停止服务：

```bash
docker compose --project-directory . -f docker/compose.yml down
```

宿主机直接运行开发进程：

```bash
npm install
npm run dev
```

常用工程命令：

```bash
npm run migrate
npm run lint
npm run build
npm test
```

构建产物：

- `dist/`：Vite 前端静态资源。
- `dist-node/`：API、迁移脚本和生产 Web 静态服务的 Node 构建产物。
- `packages/cli/dist/index.js`：发布 CLI 包时生成的命令行入口。

## 端到端测试

默认测试入口：

```bash
npm test
```

`npm test` 会执行 `tests/run-e2e.sh`，启动 Docker 测试环境，然后在 `app` 容器内运行 `tests/full-test-runner.ts`。总入口会依次执行：

1. `tests/api/full-test.ts`
2. `tests/cli/full-test.ts`
3. `playwright test`

测试会走真实 HTTP、真实 CLI、真实浏览器、真实 PostgreSQL 和真实 workspace。测试开始前会清空测试数据库和测试 workspace，结束后也会清理测试数据。

全功能测试覆盖清单维护在 `docs/可测试功能.md`。新增或修改功能后，先更新该清单，再同步更新 API、CLI、Web 测试脚本。

测试环境使用独立运行时目录：

```text
runtime/fulltest-docker/postgres
runtime/fulltest-docker/workspaces
runtime/fulltest-docker/runner
runtime/fulltest-docker/playwright-report
runtime/fulltest-docker/test-results
runtime/fulltest-docker/compose.log
```

失败时会保留 Playwright 报告、测试结果和 Compose 日志，便于排查；该环境不污染 `runtime/dev` 和 `runtime/prod`。

手动清理测试环境：

```bash
docker compose --project-directory . -f docker/compose.yml -f docker/compose.test.yml down
rm -rf runtime/fulltest-docker
```

## 部署

生产部署使用 `docker/compose.prod.yml` 覆盖开发 Compose：

```bash
cp .env.prod.example .env.prod
```

编辑 `.env.prod` 后启动：

```bash
docker compose --project-directory . -f docker/compose.yml -f docker/compose.prod.yml up -d --build app db
```

生产容器启动时会先运行迁移，再同时启动：

- API 服务：`dist-node/src/server/index.js`
- Web 静态服务：`dist-node/scripts/serve-web.js`

生产 Web 服务会代理 `/api/*` 到同容器 API，并对其他路径提供 SPA fallback，因此 `/s/:slug` 公开分享页可直接访问。

查看日志：

```bash
docker compose --project-directory . -f docker/compose.yml -f docker/compose.prod.yml logs -f app
```

停止：

```bash
docker compose --project-directory . -f docker/compose.yml -f docker/compose.prod.yml down
```

## API 使用

API 成功响应统一包在 `data` 字段：

```json
{ "data": {} }
```

错误响应：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Required input is missing or invalid."
  }
}
```

登录获取 token：

```bash
curl -s http://localhost:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"change-me"}'
```

后续请求带 Bearer token：

```bash
TOKEN=...
curl -s http://localhost:8080/api/auth/me \
  -H "authorization: Bearer $TOKEN"
```

常用 API：

```text
GET    /api/health

POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/admin/users/pending
POST   /api/admin/users/:userId/activate

POST   /api/folders
GET    /api/folders?path=/docs
PATCH  /api/folders/move
DELETE /api/folders?path=/docs
GET    /api/tree

POST   /api/notes
GET    /api/notes?path=/docs/a.md
PUT    /api/notes?path=/docs/a.md
PATCH  /api/notes/move
DELETE /api/notes?path=/docs/a.md

GET    /api/version/status
GET    /api/version/diff
POST   /api/version/commit
GET    /api/version/history
POST   /api/version/discard
POST   /api/version/restore

POST   /api/search/glob
POST   /api/search/grep
GET    /api/search/read?path=/docs/a.md&offset=1&limit=20

GET    /api/export.zip
POST   /api/import/dry-run
POST   /api/import

POST   /api/shares
GET    /api/shares
DELETE /api/shares/:shareId
GET    /api/shares/public/:slug
GET    /s/:slug
```

创建文件夹和笔记：

```bash
curl -s http://localhost:8080/api/folders \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"path":"/docs"}'

curl -s http://localhost:8080/api/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"path":"/docs/a.md","content":"# A\n"}'
```

编辑笔记需要先读取当前 `fileVersion`，再通过 `ifMatch` 提交：

```bash
curl -s 'http://localhost:8080/api/notes?path=/docs/a.md' \
  -H "authorization: Bearer $TOKEN"

curl -s 'http://localhost:8080/api/notes?path=/docs/a.md' \
  -X PUT \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"content":"# B\n","ifMatch":"<fileVersion>"}'
```

提交变更：

```bash
curl -s http://localhost:8080/api/version/commit \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"message":"initial notes"}'
```

## CLI 使用

仓库开发环境中运行：

```bash
NOTES_API_URL=http://localhost:8080 npm run notes -- health
```

已启动开发容器后运行真实 CLI：

```bash
docker compose --project-directory . -f docker/compose.yml exec app notes health
```

CLI 已发布到 npm，可直接安装：

```bash
npm install -g cloud-markdown-notes
notes config set-api-url https://notes.example.com
notes auth login alice alice-password
notes health
```

也可以单次通过 `--api-url` 指定服务端地址：

```bash
notes --api-url https://notes.example.com auth login alice alice-password
```

CLI 配置默认保存在 `~/.config/cloud-markdown-notes/config.json`，可通过 `NOTES_CONFIG_PATH` 指定其他路径。登录成功后会保存当前 API URL 和会话 token。

API URL 生效优先级：

1. `--api-url`
2. `NOTES_API_URL`
3. 配置文件
4. 默认 `http://localhost:8080`

Token 生效优先级：

1. `--token`
2. `NOTES_TOKEN`
3. 配置文件

常用命令：

```bash
notes health
notes config get
notes config set-api-url http://localhost:8080

notes auth register alice alice-password
notes auth login admin change-me
notes auth me
notes auth logout

notes admin pending-users
notes admin activate <user-id>

notes folder mkdir /docs
notes folder ls /docs
notes folder mv /docs /archive/docs
notes folder rm /archive/docs
notes tree

notes note create /docs/a.md --content "# A"
notes note create /docs/b.md --file local.md
notes note read /docs/a.md
notes note replace /docs/a.md --content "# B"
notes note replace /docs/a.md --file local.md
notes note mv /docs/a.md /docs/c.md
notes note rm /docs/c.md

notes status
notes diff
notes commit -m "save notes"
notes history
notes discard
notes restore --commit <sha> --path /docs/a.md --type file

notes search glob "**/*.md"
notes search grep "todo" --ignore-case --glob "docs/**/*.md"
notes search read /docs/a.md --offset 1 --limit 20

notes export -o notes.zip
notes import notes.zip --dry-run
notes import notes.zip

notes share publish /docs/a.md
notes share list
notes share unpublish <share-id>
```

所有命令都支持 `--json` 输出脚本友好的 JSON：

```bash
notes status --json
```

### CLI 包维护

CLI 对外发布包位于 `packages/cli`，npm 包名是 `cloud-markdown-notes`，当前可通过 `npm install -g cloud-markdown-notes` 直接安装。

维护者发布新版本前，先在仓库根目录跑完整测试，再检查包内容：

```bash
npm test
cd packages/cli
npm pack --dry-run
```

`packages/cli/package.json` 的 `bin.notes` 指向 `dist/index.js`。执行 `npm pack` 或 `npm publish` 时，`prepack` 会回到仓库根目录执行 `npm run build:cli`，把 `src/cli/index.ts` 构建进 CLI 包。

完整测试中的 CLI 流程会先执行 `npm pack`，再把生成的包安装到临时目录，并使用安装后的 `notes` 命令跑端到端用例。

CLI 包没有运行时 npm 依赖。用户安装 `cloud-markdown-notes` 时只会安装 CLI 客户端，不会安装 API、PostgreSQL、React 或 Web UI 相关依赖。

确认 dry-run 包内容无误后，在 `packages/cli` 目录发布：

```bash
npm publish
```

## Web UI 使用

启动服务后访问：

```text
http://localhost:5173
```

基本流程：

1. 使用管理员账号登录。
2. 普通用户注册后，管理员在 `admin` 页签中加载待激活用户并激活。
3. 普通用户登录后，在左侧工作区树创建文件夹和笔记。
4. 中间区域编辑 Markdown，右侧实时预览；保存时使用 `fileVersion` 防止覆盖服务器上的新版本。
5. `version` 页签查看 status、diff、提交历史、恢复路径和丢弃未提交变更。
6. `search` 页签使用 Glob、Grep、Read。
7. `transfer` 页签导出 zip，或选择 zip 做 dry-run 与正式导入。
8. `shares` 页签发布当前已提交笔记并生成公开链接，取消发布后链接失效。

公开分享页面路径：

```text
/s/:slug
```

分享只展示发布时 commit 中的内容，未提交草稿不会公开。

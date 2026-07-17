# Cloud Markdown Notes

云端 Markdown 笔记系统，提供同一套笔记能力的 API、CLI 和 Web UI 三端入口。

当前能力：

- 用户注册、登录、退出、会话校验，以及管理员激活普通用户。
- 每个用户独立 workspace，普通用户最多 1000 篇 `.md` 笔记，管理员不受该限制。
- 文件夹和 Markdown 笔记的创建、读取、整篇替换、局部行编辑、移动、删除；空文件夹会通过 `.notes-meta/folders.json` 保留。
- 笔记编辑使用 `fileVersion` 和 `ifMatch` 做并发冲突保护。
- Git 风格版本管理：`status`、`diff`、`commit`、`history`、`show`、`discard`、`restore`。
- Glob、Grep、Read 检索，仅面向工作区内的 Markdown 笔记和文件夹。
- zip 导入、dry-run 冲突检查和 zip 导出。
- 单篇已提交笔记公开分享；分享固定到发布时的 commit，取消发布或删除已提交文件后失效。
- 独立 npm CLI 包：`cloud-markdown-notes`，包内只包含命令行客户端。

## 运行环境

开发、测试和生产部署推荐使用 Docker 容器化环境。宿主机只需要：

- Docker
- Docker Compose

只安装已发布 CLI 包时，Node.js 18+ 即可。

## 环境变量

开发环境使用仓库内的 `.env.dev`。

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

应用进程的 dotenv 加载规则：

- `APP_ENV=development` 或未设置 `APP_ENV` 时，默认读取 `.env.dev`，方便本地开发。
- `APP_ENV=test` 和 `APP_ENV=production` 时，默认不读取 `.env.dev`，只使用 Docker Compose 或宿主环境已经注入的变量。
- 如需显式指定 dotenv 文件，可设置 `DOTENV_CONFIG_PATH=/path/to/env-file`。

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

默认应用镜像是 `miketop/cloud-markdown-notes:latest`。如需固定版本或使用其他 Docker Hub 仓库，在 `.env.prod` 中修改：

```text
NOTES_IMAGE=miketop/cloud-markdown-notes:0.3.1
```

## 开发运行

启动 Docker 开发服务：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml up -d app db
```

默认访问：

- API: `http://localhost:8080/api`
- Web UI: `http://localhost:5173`

查看日志：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml logs -f app
```

停止服务：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml down
```

开发 Compose 项目名固定为 `notes-dev`，避免和测试、生产容器互相覆盖。

需要执行工程命令时，在开发容器内运行：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml exec app npm run migrate
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml exec app npm run lint
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml exec app npm run build
```

构建产物：

- `dist/`：Vite 前端静态资源。
- `dist-node/`：API、迁移脚本和生产 Web 静态服务的 Node 构建产物。
- `packages/cli/dist/index.js`：发布 CLI 包时生成的命令行入口。

## 端到端测试

Docker 测试入口：

```bash
sh tests/run-e2e.sh
```

`tests/run-e2e.sh` 会启动 Docker 测试环境，然后在 `app` 容器内运行 `tests/full-test-runner.ts`。总入口会依次执行：

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
runtime/fulltest-docker/full-test-runner.log
runtime/fulltest-docker/compose.log
```

失败时会保留完整测试 runner 日志、Playwright 报告、测试结果和 Compose 日志，便于排查；该环境不污染 `runtime/dev` 和 `runtime/prod`。

测试 Compose 项目名固定为 `notes-test`，不会复用开发或生产容器。

手动清理测试环境：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml -f docker/compose.test.yml down
rm -rf runtime/fulltest-docker
```

## 部署

生产部署只需要 Docker Compose 配置和环境变量文件，不需要克隆源码、安装 Node.js 依赖或在服务器上构建前端。

在服务器上创建部署目录并下载两个文件：

```bash
mkdir -p cloud-markdown-notes
cd cloud-markdown-notes
curl -fsSL https://raw.githubusercontent.com/wzxklm/cloud-markdown-notes/main/docker/compose.prod.yml -o compose.yml
curl -fsSL https://raw.githubusercontent.com/wzxklm/cloud-markdown-notes/main/.env.prod.example -o .env.prod
```

编辑 `.env.prod`，至少修改 `POSTGRES_PASSWORD`、`SESSION_SECRET`、`ADMIN_PASSWORD` 和 `PUBLIC_BASE_URL`。然后拉取镜像并启动：

```bash
docker compose --env-file .env.prod pull
docker compose --env-file .env.prod up -d
```

Compose 会拉取 `NOTES_IMAGE` 指定的应用镜像和 PostgreSQL 镜像，等待数据库健康后运行迁移并启动 API 与 Web 服务。默认数据保存在部署目录的 `runtime/prod` 中。

需要在仓库内从当前源码构建生产镜像时，可执行：

```bash
docker build --target production -t cloud-markdown-notes:local -f docker/Dockerfile .
NOTES_IMAGE=cloud-markdown-notes:local docker compose --env-file .env.prod --project-directory . -f docker/compose.prod.yml up -d
```

生产容器启动时会先运行迁移，再同时启动：

- API 服务：`dist-node/src/server/index.js`
- Web 静态服务：`dist-node/scripts/serve-web.js`

生产 Web 服务会代理 `/api/*` 到同容器 API，并对其他路径提供 SPA fallback，因此 `/s/:slug` 公开分享页可直接访问。

查看日志：

```bash
docker compose --env-file .env.prod logs -f app
```

停止：

```bash
docker compose --env-file .env.prod down
```

生产 Compose 项目名固定为 `notes-prod`，不会被开发或测试环境的 `down` 清理。

### 更新生产容器

在部署目录执行：

```bash
docker compose --env-file .env.prod pull app
docker compose --env-file .env.prod up -d app db
```

更新后检查容器和 API 健康状态：

```bash
docker compose --env-file .env.prod ps
curl -fsS http://127.0.0.1:8080/api/health
```

如果修改了 `PROD_HOST_API_PORT`，健康检查命令中的 `8080` 也应替换为对应端口。

### 发布 Docker Hub 镜像

GitHub Actions 工作流 `.github/workflows/docker-publish.yml` 会构建 Dockerfile 的 `production` 阶段，并发布 `linux/amd64`、`linux/arm64` 多架构镜像。

首次使用前，在 GitHub 仓库的 Actions secrets 中配置：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名。
- `DOCKERHUB_TOKEN`：具有目标仓库读写权限的 Docker Hub access token。

镜像默认发布到 `miketop/cloud-markdown-notes`。仓库名不同时，在 GitHub Actions repository variables 中设置 `DOCKERHUB_IMAGE`，值为完整的 `<namespace>/<repository>`。

发布规则：

- 推送到 `main`：发布 `latest` 和 `sha-<短提交号>`。
- 推送 `v0.3.1` 这类 Git 标签：发布 `0.3.1`、`0.3`、`latest` 和提交号标签。
- 在 GitHub Actions 页面手动运行：发布所选分支对应的 `latest`（仅默认分支）和提交号标签。

生产环境建议把 `NOTES_IMAGE` 固定为明确的版本标签；需要快速跟随主分支时再使用 `latest`。

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
PATCH  /api/notes?path=/docs/a.md
PATCH  /api/notes/move
DELETE /api/notes?path=/docs/a.md

GET    /api/version/status
GET    /api/version/diff
POST   /api/version/commit
GET    /api/version/history
GET    /api/version/show?commit=<sha>
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

curl -s 'http://localhost:8080/api/notes?path=/docs/a.md' \
  -X PATCH \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"ifMatch":"<fileVersion>","fromLine":2,"toLine":3,"content":"替换内容"}'
```

`PATCH /api/notes` 使用从 1 开始的闭区间行号，`content` 可以是多行；`content:""` 表示删除该行范围。

提交变更：

```bash
curl -s http://localhost:8080/api/version/commit \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"message":"initial notes"}'
```

## CLI 使用

已启动开发容器后运行真实 CLI：

```bash
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml exec app notes health
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

notes note create /docs/a.md <<'MARKDOWN'
# A
MARKDOWN
notes note create /docs/b.md < local.md
notes note read /docs/a.md
notes note replace /docs/a.md < local.md
notes note edit /docs/a.md --from-line 10 --to-line 12 <<'MARKDOWN'
替换内容
MARKDOWN
notes note edit /docs/a.md --from-line 10 --to-line 12 < /dev/null
notes note mv /docs/a.md /docs/c.md
notes note rm /docs/c.md

notes status
notes diff
notes commit -m "save notes"
notes history
notes show <sha>
notes discard
notes restore --commit <sha> --path /docs/a.md --type file

notes search glob "**/*.md"
notes search grep "todo" --ignore-case --glob "docs/**/*.md"
notes search read /docs/a.md --offset 1 --limit 20

notes search grep "目标内容" --json
notes search read /docs/a.md --offset 20 --limit 20 --json
notes note edit /docs/a.md --from-line 27 --to-line 31 <<'MARKDOWN'
新内容
MARKDOWN

notes export -o notes.zip
notes import notes.zip --dry-run
notes import notes.zip

notes share publish /docs/a.md
notes share list
notes share unpublish <share-id>
```

`note create`、`note replace` 和 `note edit` 的 Markdown 正文只从标准输入读取。可以使用 `< local.md`、管道或带引号的 heredoc（`<<'MARKDOWN'`）传入内容，正文不会进入命令行参数，也不会被 shell 展开。空的标准输入表示空正文；用于 `note edit` 时会删除指定行范围。

版本管理命令返回的状态和 patch diff 会保留非 ASCII 路径的原始文件名。

所有命令都支持 `--json` 输出脚本友好的 JSON：

```bash
notes status --json
```

### CLI 包维护

CLI 对外发布包位于 `packages/cli`，npm 包名是 `cloud-markdown-notes`，当前可通过 `npm install -g cloud-markdown-notes` 直接安装。

维护者发布新版本前，先运行 Docker 完整测试，再在开发容器内检查包内容：

```bash
sh tests/run-e2e.sh
docker compose --env-file .env.dev --project-directory . -f docker/compose.yml exec app sh -lc 'cd packages/cli && npm pack --dry-run'
```

`packages/cli/package.json` 的 `bin.notes` 指向 `dist/index.js`。执行 `npm pack` 或 `npm publish` 时，`prepack` 会回到仓库根目录执行 `npm run build:cli`，把 `src/cli/index.ts` 构建进 CLI 包。

完整测试中的 CLI 流程会先执行 `npm pack`，再把生成的包安装到临时目录，并使用安装后的 `notes` 命令跑端到端用例。

CLI 包没有运行时 npm 依赖。用户安装 `cloud-markdown-notes` 时只会安装 CLI 客户端，不会安装 API、PostgreSQL、React 或 Web UI 相关依赖。

确认 dry-run 包内容无误后，在 `packages/cli` 目录发布：

```bash
npm publish --access public
```

发布后在需要使用 CLI 的主机上更新全局安装：

```bash
npm install -g cloud-markdown-notes@latest
npm list -g cloud-markdown-notes --depth=0
notes --api-url http://127.0.0.1:8080 health --json
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
4. 中间区域编辑 Markdown，右侧使用 GFM Markdown 渲染实时预览；保存时使用 `fileVersion` 防止覆盖服务器上的新版本。
5. `version` 页签查看 status、diff、提交历史、历史提交详情、恢复路径和丢弃未提交变更。
6. `search` 页签使用 Glob、Grep、Read。
7. `transfer` 页签导出 zip，或选择 zip 做 dry-run 与正式导入。
8. `shares` 页签发布当前已提交笔记并生成公开链接，取消发布后链接失效。

桌面端工作区固定为浏览器视口高度，目录、Markdown 编辑器、预览和工具管理面板分别独立滚动；窄屏设备使用纵向页面布局。

公开分享页面路径：

```text
/s/:slug
```

分享只展示发布时 commit 中的内容，未提交草稿不会公开。

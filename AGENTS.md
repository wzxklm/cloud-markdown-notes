# AI 开发约束

## 1. 功能优先，避免过度设计

项目仍处于早期演进阶段，开发时以实现目标功能为主，优先采用直观、清晰、可验证的代码逻辑完成需求。

- 不做超出当前需求范围的架构设计。
- 不为了未来可能出现的场景提前引入复杂抽象。
- 不进行过度编程、过度封装或过度防御。
- 代码逻辑应尽量精简，能直接表达业务意图。
- 项目结构应保持逻辑清晰，优先按职责进行模块化设计，避免目录和模块层级过深。
- 新增文件或目录时，应优先放在现有职责边界内；只有职责确实独立时才新增模块。
- 只有当重复、复杂度或维护成本已经明确出现时，再考虑抽象和重构。
- 优先保证功能可运行、流程可闭环、结果可验证。

## 2. 测试环境

当前项目已经具备完整测试环境，开发后应尽量完成可验证的测试闭环。

- 默认测试入口是 `npm test`。
- `npm test` 会执行 `tests/run-e2e.sh`，通过 `docker/compose.yml` 和 `docker/compose.test.yml` 启动 Docker 测试环境。
- 测试环境在 `app` 容器内执行 `tests/full-test-runner.ts`。
- `tests/full-test-runner.ts` 会重置测试数据库和测试 workspace，然后依次执行 API 全流程测试、CLI 全流程测试和 Playwright Web UI 全流程测试。
- API 测试入口是 `tests/api/full-test.ts`。
- CLI 测试入口是 `tests/cli/full-test.ts`；该流程会先对 `packages/cli` 执行真实 `npm pack`，再安装包并使用安装后的 `notes` 命令测试。
- Web 测试入口是 `tests/web/*.spec.ts`，公共辅助函数位于 `tests/web/helpers.ts`。
- 测试运行时数据放在 `runtime/fulltest-docker`，不会污染 `runtime/dev` 和 `runtime/prod`。
- 新增、删除或修改可测试功能时，应先更新 `docs/可测试功能.md`；API、CLI、Web 全功能测试脚本应以该文件作为覆盖清单同步维护。
- 新增、删除或修改用户可见功能、命令、接口、部署流程或测试流程时，应同步更新 `README.md` 中对应的使用说明、API/CLI 命令清单和 Web 流程说明。
- 新增、删除或修改 CLI 能力时，应同步更新 `packages/cli/README.md` 和 `docs/skills/cloud-notes-cli/SKILL.md`；如果该能力也影响本机已安装的 Codex skill，应同步更新 `/root/.codex/skills/cloud-notes-cli/SKILL.md`。
- 只有当需求涉及真实 Web UI 体验、视觉状态、复杂交互手感或自动化测试无法覆盖的问题时，才使用浏览器 MCP 进行 AI 手动实测。
- 使用浏览器 MCP 手动测试时，应优先复用 Docker 暴露到主机的 Web 端口，并覆盖关键用户路径，而不是只做页面是否能打开的浅层检查。

## 3. Git 提交规范

用户要求提交代码时，commit message 应完整记录本次变更，便于后续留档、审计和问题追溯。

- 不使用只有一句简短标题、缺少正文说明的提交。
- 提交标题应简洁概括核心目的，正文应说明具体改动内容、变更原因、影响范围和验证结果。
- 如果本次没有运行测试，应在提交正文中明确说明未运行的原因。
- 如果涉及风险修复、数据安全、部署流程、测试环境或生产环境，应在正文中说明背景和避免的问题。
- 提交前应检查 `git diff`，确认只包含本次任务相关改动，避免把无关文件混入同一个提交。
- 推荐提交信息格式：

```text
<简短标题>

Changes:
- <具体改动 1>
- <具体改动 2>

Reason:
- <为什么要改，解决什么问题>

Validation:
- <执行过的检查或测试>
- <如未运行测试，说明原因>
```

## 4. 项目结构速览

以下目录树用于快速理解项目职责。`node_modules`、`.git`、`runtime` 内部文件数量较多，一般不需要逐个展开；其中 `runtime` 是运行时数据目录，不是源码。

```text
.
├── AGENTS.md                         # AI 开发约束和项目结构说明
├── README.md                         # 项目运行、测试、部署、API、CLI 和 Web 使用说明
├── index.html                        # Vite Web 入口 HTML
├── package.json                      # 根项目脚本、依赖和开发 CLI 入口
├── package-lock.json                 # npm 依赖锁定文件
├── tsconfig.json                     # TypeScript 配置
├── vite.config.ts                    # Vite/React 配置和开发 API 代理
├── playwright.config.ts              # Playwright Web 端到端测试配置
├── eslint.config.js                  # ESLint 配置
├── .env.dev                          # 开发环境变量
├── .env.prod                         # 生产环境变量，本地私有文件
├── .env.prod.example                 # 生产环境变量示例
├── .gitignore                        # Git 忽略规则
├── .dockerignore                     # Docker 构建忽略规则
├── .prettierrc                       # Prettier 格式化规则
├── .prettierignore                   # Prettier 忽略规则
├── .codex/
│   └── config.toml                   # 本地浏览器 MCP 配置
├── docker/
│   ├── Dockerfile                    # development/build/production 多阶段镜像
│   ├── compose.yml                   # 开发环境 Docker Compose
│   ├── compose.test.yml              # 测试环境 Compose 覆盖配置
│   ├── compose.prod.yml              # 生产环境 Compose 覆盖配置
│   ├── entrypoint.sh                 # 容器启动前安装依赖并准备 workspace
│   └── notes.sh                      # 容器内 notes CLI 包装脚本
├── docs/
│   └── 可测试功能.md                  # API、CLI、Web 全功能测试覆盖清单
├── packages/
│   └── cli/
│       ├── package.json              # 发布包 cloud-markdown-notes 的 manifest
│       ├── README.md                 # CLI 包说明
│       └── dist/index.js             # npm pack/publish 前生成的 CLI 产物
├── scripts/
│   ├── migrate.ts                    # 执行数据库迁移
│   ├── serve-web.ts                  # 生产静态 Web 服务、API 代理和 SPA fallback
│   └── start-prod.ts                 # 生产环境同时启动 API 和 Web
├── src/
│   ├── cli/
│   │   └── index.ts                  # notes 命令行入口和所有 CLI 命令
│   ├── server/
│   │   ├── app.ts                    # 创建 Fastify 应用、健康检查和路由注册
│   │   ├── index.ts                  # 后端服务启动入口
│   │   ├── config.ts                 # 读取环境变量并生成配置
│   │   ├── db.ts                     # PostgreSQL 连接池
│   │   ├── auth.ts                   # 注册、登录、会话、退出和管理员激活
│   │   ├── content.ts                # 文件夹和 Markdown 笔记 CRUD
│   │   ├── version.ts                # Git 风格版本管理能力
│   │   ├── extensions.ts             # 搜索、导入导出和公开分享
│   │   ├── workspace.ts              # 用户 workspace、路径安全、空文件夹元数据和笔记数量限制
│   │   └── migrations/
│   │       ├── 0000_init.sql         # 初始化元数据表
│   │       ├── 0001_auth.sql         # 用户和会话表
│   │       └── 0002_shares.sql       # 公开分享表
│   ├── shared/
│   │   ├── api.ts                    # 统一 API 成功响应和健康检查类型
│   │   └── errors.ts                 # 统一错误码和错误响应结构
│   └── web/
│       ├── main.tsx                  # React 挂载入口
│       ├── App.tsx                   # Web 主界面、认证、工作区和工具页签
│       ├── MarkdownPreview.tsx       # 轻量 Markdown 预览组件
│       └── styles.css                # Web 样式
├── tests/
│   ├── full-test-runner.ts           # 完整端到端测试总入口
│   ├── run-e2e.sh                    # Docker 测试环境启动脚本
│   ├── api/
│   │   └── full-test.ts              # API 全流程测试
│   ├── cli/
│   │   └── full-test.ts              # CLI 全流程测试
│   └── web/
│       ├── helpers.ts                # Web 测试公共辅助函数
│       ├── web-auth.spec.ts          # 注册、激活和登录测试
│       ├── web-notes.spec.ts         # 笔记编辑和版本流程测试
│       ├── web-import-export.spec.ts # 搜索和导入导出测试
│       └── web-share.spec.ts         # 公开分享测试
├── dist/                             # 前端构建产物，由 npm run build 生成
├── dist-node/                        # Node 端构建产物，由 npm run build:server 生成
├── runtime/                          # 开发、测试和生产运行时数据
├── node_modules/                     # npm 第三方依赖
└── .git/                             # Git 仓库内部数据
```

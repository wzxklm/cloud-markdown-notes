#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiSuccess, HealthStatus } from "../shared/api";
import type { ApiError } from "../shared/errors";

type CliConfig = {
  apiUrl?: string;
  token?: string;
};

type CliOptions = {
  apiUrl: string;
  apiUrlSource: "flag" | "env" | "config" | "default";
  json: boolean;
  token?: string;
  tokenSource: "flag" | "env" | "config" | "none";
  configPath: string;
  config: CliConfig;
};

type CliIo = {
  stdin: () => Promise<string>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

type ParsedCommandArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type CommandResult = {
  raw: unknown;
  human: string | string[];
};

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "pending";
  createdAt: string;
  activatedAt: string | null;
};

type FolderEntry = {
  name: string;
  path: string;
  type: "folder" | "note" | "file";
};

type TreeNode = FolderEntry & {
  children?: TreeNode[];
};

type Note = {
  path: string;
  content: string;
  fileVersion: string;
};

type GitChange = {
  path: string;
  oldPath?: string;
  changeType: string;
  indexStatus: string;
  worktreeStatus: string;
};

type Commit = {
  sha: string;
  message: string;
  committedAt: string;
};

type CommitDetail = {
  commit: Commit;
  diff: string;
};

type SearchMatch = {
  path: string;
  type: "folder" | "note";
};

type GrepMatch = {
  path: string;
  lineNumber: number;
  line: string;
};

type Share = {
  id: string;
  notePath: string;
  slug: string;
  url: string;
  commitSha: string;
  active: boolean;
  createdAt: string;
};

const defaultApiUrl = "http://localhost:8080";
const booleanFlags = new Set(["dry-run", "regex", "ignore-case", "json"]);
const shortFlagAliases: Record<string, string> = {
  m: "message",
  o: "output"
};

const defaultIo: CliIo = {
  stdin: readStdin,
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message)
};

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let content = "";
  for await (const chunk of process.stdin) {
    content += chunk;
  }
  return content;
}

class CliHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | undefined
  ) {
    super(body?.error.message ?? `Request failed with HTTP ${status}.`);
  }
}

async function loadConfig(configPath: string): Promise<CliConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const config = parsed as CliConfig;
    return {
      apiUrl: typeof config.apiUrl === "string" ? config.apiUrl : undefined,
      token: typeof config.token === "string" ? config.token : undefined
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {};
    }

    throw error;
  }
}

async function saveConfig(configPath: string, config: CliConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const configuredPath = envValue(env, "NOTES_CONFIG_PATH");
  if (configuredPath) {
    return configuredPath;
  }

  const configRoot =
    envValue(env, "XDG_CONFIG_HOME") ?? path.join(envValue(env, "HOME") ?? os.homedir(), ".config");
  return path.join(configRoot, "cloud-markdown-notes", "config.json");
}

async function parseOptions(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{
  command: string[];
  options: CliOptions;
}> {
  const command: string[] = [];
  let json = false;
  let apiUrlFromFlag: string | undefined;
  let tokenFromFlag: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--api-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--api-url requires a value.");
      }
      apiUrlFromFlag = value;
      index += 1;
    } else if (arg.startsWith("--api-url=")) {
      apiUrlFromFlag = arg.slice("--api-url=".length);
    } else if (arg === "--token") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--token requires a value.");
      }
      tokenFromFlag = value;
      index += 1;
    } else if (arg.startsWith("--token=")) {
      tokenFromFlag = arg.slice("--token=".length);
    } else {
      command.push(arg);
    }
  }

  const configPath = resolveConfigPath(env);
  const config = await loadConfig(configPath);
  const apiUrlFromEnv = envValue(env, "NOTES_API_URL");
  const tokenFromEnv = envValue(env, "NOTES_TOKEN");
  const apiUrl = apiUrlFromFlag ?? apiUrlFromEnv ?? config.apiUrl ?? defaultApiUrl;
  const apiUrlSource = apiUrlFromFlag
    ? "flag"
    : apiUrlFromEnv
      ? "env"
      : config.apiUrl
        ? "config"
        : "default";
  const token = tokenFromFlag ?? tokenFromEnv ?? config.token;
  const tokenSource = tokenFromFlag
    ? "flag"
    : tokenFromEnv
      ? "env"
      : config.token
        ? "config"
        : "none";

  return {
    command,
    options: {
      apiUrl,
      apiUrlSource,
      json,
      token,
      tokenSource,
      configPath,
      config
    }
  };
}

function parseCommandArgs(args: string[]): ParsedCommandArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!rawName) {
        continue;
      }

      if (inlineValue !== undefined) {
        flags[rawName] = inlineValue;
      } else if (booleanFlags.has(rawName)) {
        flags[rawName] = true;
      } else {
        const value = args[index + 1];
        if (value === undefined) {
          throw new Error(`--${rawName} requires a value.`);
        }
        flags[rawName] = value;
        index += 1;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const rawName = arg.slice(1);
      const name = shortFlagAliases[rawName] ?? rawName;
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`-${rawName} requires a value.`);
      }
      flags[name] = value;
      index += 1;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function printHelp(io: CliIo): void {
  io.stdout(`Usage:
  notes health [--json] [--api-url <url>]
  notes config get
  notes config set-api-url <url>
  notes auth register <username> <password>
  notes auth login <username> <password>
  notes auth logout
  notes auth me
  notes admin pending-users
  notes admin activate <user-id>
  notes folder mkdir <path>
  notes folder ls [path]
  notes folder mv <from> <to>
  notes folder rm <path>
  notes tree
  notes note create <path> < content.md
  notes note read <path>
  notes note replace <path> < content.md
  notes note edit <path> --from-line n --to-line n < replacement.md
  notes note mv <from> <to>
  notes note rm <path>
  notes status
  notes diff
  notes commit -m "message"
  notes history
  notes show <sha>
  notes discard
  notes restore --commit <sha> --path <path> [--type file|folder]
  notes search glob <pattern>
  notes search grep <pattern> [--regex] [--ignore-case] [--glob pattern]
  notes search read <path> [--offset n] [--limit n]
  notes import file.zip [--dry-run]
  notes export -o notes.zip
  notes share publish <path>
  notes share unpublish <share-id>
  notes share list

Global options:
  --json
  --api-url <url>
  --token <token>

Markdown content for note create, replace, and edit is read from stdin.`);
}

async function apiRequest<T>(
  options: CliOptions,
  pathname: string,
  requestOptions: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    rawBody?: BodyInit;
    headers?: Record<string, string>;
    auth?: boolean;
  } = {}
): Promise<T> {
  const url = new URL(pathname, options.apiUrl);
  for (const [key, value] of Object.entries(requestOptions.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    ...requestOptions.headers
  };

  if (requestOptions.auth !== false) {
    if (!options.token) {
      throw new Error("Authentication token is required. Run notes auth login or pass --token.");
    }
    headers.authorization = `Bearer ${options.token}`;
  }

  const init: RequestInit = {
    method: requestOptions.method ?? "GET",
    headers
  };

  if (requestOptions.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(requestOptions.body);
  } else if (requestOptions.rawBody !== undefined) {
    init.body = requestOptions.rawBody;
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? parseJsonBody(text) : undefined;

  if (!response.ok) {
    throw new CliHttpError(response.status, isApiError(parsed) ? parsed : undefined);
  }

  return parsed as T;
}

async function downloadFile(
  options: CliOptions,
  pathname: string,
  outputPath: string
): Promise<void> {
  if (!options.token) {
    throw new Error("Authentication token is required. Run notes auth login or pass --token.");
  }

  const response = await fetch(new URL(pathname, options.apiUrl), {
    headers: {
      authorization: `Bearer ${options.token}`
    }
  });

  if (!response.ok) {
    const parsed = parseJsonBody(await response.text());
    throw new CliHttpError(response.status, isApiError(parsed) ? parsed : undefined);
  }

  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isApiError(value: unknown): value is ApiError {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    typeof (value as ApiError).error?.message === "string"
  );
}

async function executeCommand(
  command: string[],
  options: CliOptions,
  readStdin: () => Promise<string>
): Promise<CommandResult> {
  const [scope, action, ...rest] = command;
  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    return {
      raw: { data: { help: true } },
      human: []
    };
  }

  if (scope === "health") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<HealthStatus>>(options, "/api/health", {
      auth: false
    });
    return {
      raw: result,
      human: [
        `API: ${result.data.status}`,
        `Database: ${result.data.database}`,
        `Workspace: ${result.data.workspace.writable ? "writable" : "not writable"}`
      ]
    };
  }

  if (scope === "config") {
    return handleConfigCommand(action, rest, options);
  }

  if (scope === "auth") {
    return handleAuthCommand(action, rest, options);
  }

  if (scope === "admin") {
    return handleAdminCommand(action, rest, options);
  }

  if (scope === "folder") {
    return handleFolderCommand(action, rest, options);
  }

  if (scope === "tree") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<{ tree: TreeNode }>>(options, "/api/tree");
    return {
      raw: result,
      human: formatTree(result.data.tree)
    };
  }

  if (scope === "note") {
    return handleNoteCommand(action, rest, options, readStdin);
  }

  if (scope === "status") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<{ changes: GitChange[] }>>(
      options,
      "/api/version/status"
    );
    return {
      raw: result,
      human:
        result.data.changes.length === 0
          ? "Clean"
          : result.data.changes.map((change) =>
              change.oldPath
                ? `${change.changeType} ${change.oldPath} -> ${change.path}`
                : `${change.changeType} ${change.path}`
            )
    };
  }

  if (scope === "diff") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<{ diff: string }>>(options, "/api/version/diff");
    return {
      raw: result,
      human: result.data.diff || "No diff"
    };
  }

  if (scope === "commit") {
    const parsed = parseCommandArgs([action, ...rest].filter(isDefinedString));
    const message = stringFlag(parsed, "message") ?? parsed.positionals.join(" ");
    requireString(message, "Commit message is required.");
    const result = await apiRequest<ApiSuccess<{ commit: { sha: string; message: string } }>>(
      options,
      "/api/version/commit",
      {
        method: "POST",
        body: { message }
      }
    );
    return {
      raw: result,
      human: `Committed ${result.data.commit.sha}: ${result.data.commit.message}`
    };
  }

  if (scope === "history") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<{ commits: Commit[] }>>(
      options,
      "/api/version/history"
    );
    return {
      raw: result,
      human:
        result.data.commits.length === 0
          ? "No commits"
          : result.data.commits.map(
              (commit) => `${commit.sha.slice(0, 12)} ${commit.committedAt} ${commit.message}`
            )
    };
  }

  if (scope === "show") {
    const parsed = parseCommandArgs([action, ...rest].filter(isDefinedString));
    const commitSha =
      parsed.positionals[0] ?? stringFlag(parsed, "commit") ?? stringFlag(parsed, "commitSha");
    requireString(commitSha, "Commit sha is required.");
    const result = await apiRequest<ApiSuccess<{ show: CommitDetail }>>(
      options,
      "/api/version/show",
      {
        query: { commit: commitSha }
      }
    );
    return {
      raw: result,
      human: formatCommitDetail(result.data.show)
    };
  }

  if (scope === "discard") {
    assertNoAction(command, action);
    const result = await apiRequest<ApiSuccess<{ ok: true }>>(options, "/api/version/discard", {
      method: "POST"
    });
    return {
      raw: result,
      human: "Discarded uncommitted changes"
    };
  }

  if (scope === "restore") {
    const parsed = parseCommandArgs([action, ...rest].filter(isDefinedString));
    const commitSha = stringFlag(parsed, "commit") ?? stringFlag(parsed, "commitSha");
    const restorePath = stringFlag(parsed, "path");
    requireString(commitSha, "--commit is required.");
    requireString(restorePath, "--path is required.");
    const result = await apiRequest<ApiSuccess<{ restored: { path: string; type: string } }>>(
      options,
      "/api/version/restore",
      {
        method: "POST",
        body: {
          commitSha,
          path: restorePath,
          type: stringFlag(parsed, "type")
        }
      }
    );
    return {
      raw: result,
      human: `Restored ${result.data.restored.type} ${result.data.restored.path}`
    };
  }

  if (scope === "search") {
    return handleSearchCommand(action, rest, options);
  }

  if (scope === "import") {
    return handleImportCommand(action, rest, options);
  }

  if (scope === "export") {
    return handleExportCommand(action, rest, options);
  }

  if (scope === "share") {
    return handleShareCommand(action, rest, options);
  }

  throw new Error(`Unknown command: ${command.join(" ")}`);
}

async function handleConfigCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "get") {
    return {
      raw: {
        data: {
          configPath: options.configPath,
          apiUrl: options.apiUrl,
          apiUrlSource: options.apiUrlSource,
          configuredApiUrl: options.config.apiUrl ?? null,
          tokenConfigured: !!options.token
        }
      },
      human: [
        `Config: ${options.configPath}`,
        `API URL: ${options.apiUrl} (${options.apiUrlSource})`,
        `Configured API URL: ${options.config.apiUrl ?? "not configured"}`,
        `Token: ${options.token ? "configured" : "not configured"}`
      ]
    };
  }

  if (action === "set-api-url") {
    const apiUrl =
      stringFlag(parsed, "api-url") ?? stringFlag(parsed, "apiUrl") ?? parsed.positionals[0];
    requireString(apiUrl, "API URL is required.");
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    await saveConfig(options.configPath, {
      ...options.config,
      apiUrl: normalizedApiUrl
    });
    options.config.apiUrl = normalizedApiUrl;
    options.apiUrl = normalizedApiUrl;
    options.apiUrlSource = "config";
    return {
      raw: {
        data: {
          configPath: options.configPath,
          apiUrl: normalizedApiUrl
        }
      },
      human: `API URL saved: ${normalizedApiUrl}`
    };
  }

  throw new Error(`Unknown command: config ${action ?? ""}`.trim());
}

async function handleAuthCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "register") {
    const username = stringFlag(parsed, "username") ?? parsed.positionals[0];
    const password = stringFlag(parsed, "password") ?? parsed.positionals[1];
    requireString(username, "Username is required.");
    requireString(password, "Password is required.");

    const result = await apiRequest<ApiSuccess<{ user: PublicUser }>>(
      options,
      "/api/auth/register",
      {
        method: "POST",
        auth: false,
        body: { username, password }
      }
    );
    return {
      raw: result,
      human: `Registered ${result.data.user.username} (${result.data.user.status})`
    };
  }

  if (action === "login") {
    const username = stringFlag(parsed, "username") ?? parsed.positionals[0];
    const password = stringFlag(parsed, "password") ?? parsed.positionals[1];
    requireString(username, "Username is required.");
    requireString(password, "Password is required.");

    const result = await apiRequest<ApiSuccess<{ token: string; user: PublicUser }>>(
      options,
      "/api/auth/login",
      {
        method: "POST",
        auth: false,
        body: { username, password }
      }
    );
    await saveConfig(options.configPath, {
      ...options.config,
      apiUrl: options.apiUrl,
      token: result.data.token
    });
    options.token = result.data.token;
    return {
      raw: result,
      human: `Logged in as ${result.data.user.username}`
    };
  }

  if (action === "logout") {
    const result = await apiRequest<ApiSuccess<{ ok: true }>>(options, "/api/auth/logout", {
      method: "POST"
    });
    if (options.tokenSource === "config") {
      await saveConfig(options.configPath, {
        ...options.config,
        apiUrl: options.apiUrl,
        token: undefined
      });
    }
    return {
      raw: result,
      human: "Logged out"
    };
  }

  if (action === "me") {
    const result = await apiRequest<ApiSuccess<{ user: PublicUser }>>(options, "/api/auth/me");
    return {
      raw: result,
      human: `${result.data.user.username} (${result.data.user.role}, ${result.data.user.status})`
    };
  }

  throw new Error(`Unknown command: auth ${action ?? ""}`.trim());
}

async function handleAdminCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  if (action === "pending-users") {
    const result = await apiRequest<ApiSuccess<{ users: PublicUser[] }>>(
      options,
      "/api/admin/users/pending"
    );
    return {
      raw: result,
      human:
        result.data.users.length === 0
          ? "No pending users"
          : result.data.users.map((user) => `${user.id} ${user.username}`)
    };
  }

  if (action === "activate") {
    const parsed = parseCommandArgs(rest);
    const userId = parsed.positionals[0];
    requireString(userId, "User id is required.");
    const result = await apiRequest<ApiSuccess<{ user: PublicUser }>>(
      options,
      `/api/admin/users/${encodeURIComponent(userId)}/activate`,
      {
        method: "POST"
      }
    );
    return {
      raw: result,
      human: `Activated ${result.data.user.username}`
    };
  }

  throw new Error(`Unknown command: admin ${action ?? ""}`.trim());
}

async function handleFolderCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "mkdir") {
    const folderPath = parsed.positionals[0];
    requireString(folderPath, "Folder path is required.");
    const result = await apiRequest<ApiSuccess<{ folder: FolderEntry }>>(options, "/api/folders", {
      method: "POST",
      body: { path: folderPath }
    });
    return {
      raw: result,
      human: `Created folder ${result.data.folder.path}`
    };
  }

  if (action === "ls") {
    const folderPath = parsed.positionals[0] ?? "/";
    const result = await apiRequest<ApiSuccess<{ path: string; entries: FolderEntry[] }>>(
      options,
      "/api/folders",
      {
        query: { path: folderPath }
      }
    );
    return {
      raw: result,
      human:
        result.data.entries.length === 0
          ? `${result.data.path} is empty`
          : result.data.entries.map((entry) => `${entry.type} ${entry.path}`)
    };
  }

  if (action === "mv") {
    const [fromPath, toPath] = parsed.positionals;
    requireString(fromPath, "Source folder path is required.");
    requireString(toPath, "Target folder path is required.");
    const result = await apiRequest<ApiSuccess<{ folder: FolderEntry }>>(
      options,
      "/api/folders/move",
      {
        method: "PATCH",
        body: { fromPath, toPath }
      }
    );
    return {
      raw: result,
      human: `Moved folder to ${result.data.folder.path}`
    };
  }

  if (action === "rm") {
    const folderPath = parsed.positionals[0];
    requireString(folderPath, "Folder path is required.");
    const result = await apiRequest<ApiSuccess<{ ok: true }>>(options, "/api/folders", {
      method: "DELETE",
      query: { path: folderPath }
    });
    return {
      raw: result,
      human: `Deleted folder ${folderPath}`
    };
  }

  throw new Error(`Unknown command: folder ${action ?? ""}`.trim());
}

async function handleNoteCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions,
  readStdin: () => Promise<string>
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "create") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    assertAllowedFlags(parsed, []);
    const content = await readStdin();
    const result = await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
      method: "POST",
      body: { path: notePath, content }
    });
    return {
      raw: result,
      human: `Created note ${result.data.note.path}`
    };
  }

  if (action === "read") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    const result = await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
      query: { path: notePath }
    });
    return {
      raw: result,
      human: result.data.note.content
    };
  }

  if (action === "replace") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    assertAllowedFlags(parsed, ["if-match"]);
    const content = await readStdin();
    const ifMatch =
      stringFlag(parsed, "if-match") ??
      (
        await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
          query: { path: notePath }
        })
      ).data.note.fileVersion;

    const result = await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
      method: "PUT",
      query: { path: notePath },
      body: { content, ifMatch }
    });
    return {
      raw: result,
      human: `Replaced note ${result.data.note.path}`
    };
  }

  if (action === "edit") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    if (stringFlag(parsed, "line") !== undefined) {
      throw new Error("--line is not supported for note edit. Use --from-line and --to-line.");
    }
    assertAllowedFlags(parsed, ["from-line", "to-line", "if-match"]);
    const content = await readStdin();
    const fromLine = requiredNumberFlag(parsed, "from-line");
    const toLine = requiredNumberFlag(parsed, "to-line");
    const ifMatch =
      stringFlag(parsed, "if-match") ??
      (
        await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
          query: { path: notePath }
        })
      ).data.note.fileVersion;

    const result = await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes", {
      method: "PATCH",
      query: { path: notePath },
      body: { ifMatch, fromLine, toLine, content }
    });
    return {
      raw: result,
      human: `Edited note ${result.data.note.path}`
    };
  }

  if (action === "mv") {
    const [fromPath, toPath] = parsed.positionals;
    requireString(fromPath, "Source note path is required.");
    requireString(toPath, "Target note path is required.");
    const result = await apiRequest<ApiSuccess<{ note: Note }>>(options, "/api/notes/move", {
      method: "PATCH",
      body: { fromPath, toPath }
    });
    return {
      raw: result,
      human: `Moved note to ${result.data.note.path}`
    };
  }

  if (action === "rm") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    const result = await apiRequest<ApiSuccess<{ ok: true }>>(options, "/api/notes", {
      method: "DELETE",
      query: { path: notePath }
    });
    return {
      raw: result,
      human: `Deleted note ${notePath}`
    };
  }

  throw new Error(`Unknown command: note ${action ?? ""}`.trim());
}

async function handleSearchCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "glob") {
    const pattern =
      stringFlag(parsed, "pattern") ?? stringFlag(parsed, "glob") ?? parsed.positionals[0];
    requireString(pattern, "Glob pattern is required.");
    const result = await apiRequest<ApiSuccess<{ matches: SearchMatch[] }>>(
      options,
      "/api/search/glob",
      {
        method: "POST",
        body: {
          pattern,
          limit: numberFlag(parsed, "limit")
        }
      }
    );
    return {
      raw: result,
      human:
        result.data.matches.length === 0
          ? "No matches"
          : result.data.matches.map((match) => `${match.type} ${match.path}`)
    };
  }

  if (action === "grep") {
    const pattern = stringFlag(parsed, "pattern") ?? parsed.positionals[0];
    requireString(pattern, "Search pattern is required.");
    const result = await apiRequest<ApiSuccess<{ matches: GrepMatch[] }>>(
      options,
      "/api/search/grep",
      {
        method: "POST",
        body: {
          pattern,
          regex: parsed.flags.regex === true,
          ignoreCase: parsed.flags["ignore-case"] === true,
          glob: stringFlag(parsed, "glob"),
          context: numberFlag(parsed, "context")
        }
      }
    );
    return {
      raw: result,
      human:
        result.data.matches.length === 0
          ? "No matches"
          : result.data.matches.map((match) => `${match.path}:${match.lineNumber}: ${match.line}`)
    };
  }

  if (action === "read") {
    const notePath = parsed.positionals[0] ?? stringFlag(parsed, "path");
    requireString(notePath, "Note path is required.");
    const result = await apiRequest<ApiSuccess<{ note: Note & { lines: unknown[] } }>>(
      options,
      "/api/search/read",
      {
        query: {
          path: notePath,
          offset: numberFlag(parsed, "offset"),
          limit: numberFlag(parsed, "limit")
        }
      }
    );
    return {
      raw: result,
      human: result.data.note.content
    };
  }

  throw new Error(`Unknown command: search ${action ?? ""}`.trim());
}

async function handleImportCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs([action, ...rest].filter(isDefinedString));
  const archivePath = parsed.positionals[0];
  requireString(archivePath, "Zip file path is required.");
  const archive = await readFile(archivePath);
  const dryRun = parsed.flags["dry-run"] === true;
  const result = await apiRequest<ApiSuccess<unknown>>(
    options,
    dryRun ? "/api/import/dry-run" : "/api/import",
    {
      method: "POST",
      rawBody: new Uint8Array(archive),
      headers: {
        "content-type": "application/zip"
      }
    }
  );
  return {
    raw: result,
    human: dryRun ? "Import dry-run complete" : "Imported zip archive"
  };
}

async function handleExportCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs([action, ...rest].filter(isDefinedString));
  const outputPath = stringFlag(parsed, "output") ?? parsed.positionals[0];
  requireString(outputPath, "Output path is required.");
  await downloadFile(options, "/api/export.zip", outputPath);
  return {
    raw: {
      data: {
        path: outputPath
      }
    },
    human: `Exported to ${outputPath}`
  };
}

async function handleShareCommand(
  action: string | undefined,
  rest: string[],
  options: CliOptions
): Promise<CommandResult> {
  const parsed = parseCommandArgs(rest);

  if (action === "publish") {
    const notePath = parsed.positionals[0];
    requireString(notePath, "Note path is required.");
    const result = await apiRequest<ApiSuccess<{ share: Share }>>(options, "/api/shares", {
      method: "POST",
      body: { path: notePath }
    });
    return {
      raw: result,
      human: `Published ${result.data.share.notePath}: ${result.data.share.url}`
    };
  }

  if (action === "unpublish") {
    const shareId = parsed.positionals[0];
    requireString(shareId, "Share id is required.");
    const result = await apiRequest<ApiSuccess<{ share: Share }>>(
      options,
      `/api/shares/${encodeURIComponent(shareId)}`,
      {
        method: "DELETE"
      }
    );
    return {
      raw: result,
      human: `Unpublished ${result.data.share.id}`
    };
  }

  if (action === "list") {
    const result = await apiRequest<ApiSuccess<{ shares: Share[] }>>(options, "/api/shares");
    return {
      raw: result,
      human:
        result.data.shares.length === 0
          ? "No shares"
          : result.data.shares.map((share) => `${share.id} ${share.notePath} ${share.url}`)
    };
  }

  throw new Error(`Unknown command: share ${action ?? ""}`.trim());
}

function assertAllowedFlags(parsed: ParsedCommandArgs, allowedFlags: string[]): void {
  for (const flag of Object.keys(parsed.flags)) {
    if (!allowedFlags.includes(flag)) {
      throw new Error(`Unknown option: --${flag}`);
    }
  }
}

function formatTree(root: TreeNode): string[] {
  const lines: string[] = [];
  for (const child of root.children ?? []) {
    appendTreeNode(lines, child, 0);
  }

  return lines.length === 0 ? ["Workspace is empty"] : lines;
}

function appendTreeNode(lines: string[], node: TreeNode, depth: number): void {
  lines.push(`${"  ".repeat(depth)}${node.type === "folder" ? "folder" : "note"} ${node.path}`);
  for (const child of node.children ?? []) {
    appendTreeNode(lines, child, depth + 1);
  }
}

function formatCommitDetail(show: CommitDetail): string {
  const header = [
    `commit ${show.commit.sha}`,
    `Date: ${show.commit.committedAt}`,
    "",
    `    ${show.commit.message}`
  ].join("\n");

  return show.diff ? `${header}\n\n${show.diff}` : header;
}

function stringFlag(parsed: ParsedCommandArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function isDefinedString(value: string | undefined): value is string {
  return value !== undefined;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim() ? value : undefined;
}

function numberFlag(parsed: ParsedCommandArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    return undefined;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`--${name} must be an integer.`);
  }

  return parsedValue;
}

function requiredNumberFlag(parsed: ParsedCommandArgs, name: string): number {
  const value = numberFlag(parsed, name);
  if (value === undefined) {
    throw new Error(`--${name} is required.`);
  }

  return value;
}

function requireString(value: string | undefined, message: string): asserts value is string {
  if (!value || !value.trim()) {
    throw new Error(message);
  }
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API URL must be a valid absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }

  return url.href.replace(/\/+$/, "");
}

function assertNoAction(command: string[], action: string | undefined): void {
  if (action) {
    throw new Error(`Unknown command: ${command.join(" ")}`);
  }
}

function printResult(result: CommandResult, options: CliOptions, io: CliIo): void {
  if (options.json) {
    io.stdout(JSON.stringify(result.raw, null, 2));
    return;
  }

  const lines = Array.isArray(result.human) ? result.human : [result.human];
  for (const line of lines) {
    if (line) {
      io.stdout(line);
    }
  }
}

function printCliError(error: unknown, json: boolean, io: CliIo): void {
  if (json) {
    const body =
      error instanceof CliHttpError && error.body
        ? error.body
        : {
            error: {
              code: "CLI_ERROR",
              message: error instanceof Error ? error.message : "Unknown CLI error."
            }
          };
    io.stderr(JSON.stringify(body, null, 2));
    return;
  }

  io.stderr(error instanceof Error ? error.message : "Unknown CLI error.");
}

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<void> {
  const env = io.env ?? process.env;
  const { command, options } = await parseOptions(args, env);
  if (!command[0] || command[0] === "help" || command[0] === "--help" || command[0] === "-h") {
    printHelp(io);
    return;
  }

  const result = await executeCommand(command, options, io.stdin);
  printResult(result, options, io);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    await runCli(args);
  } catch (error) {
    printCliError(error, args.includes("--json"), defaultIo);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (
  entryPath &&
  (modulePath === entryPath || safeRealpath(modulePath) === safeRealpath(entryPath))
) {
  void main();
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

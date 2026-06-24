import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApiSuccess } from "../shared/api";
import type { ApiError, ErrorCode } from "../shared/errors";
import { MarkdownPreview } from "./MarkdownPreview";

type PublicUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "active" | "pending";
  createdAt: string;
  activatedAt: string | null;
};

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "note" | "file";
  children?: TreeNode[];
};

type Note = {
  path: string;
  content: string;
  fileVersion: string;
};

type SelectedPath = {
  path: string;
  type: "folder" | "note";
};

type GitChange = {
  path: string;
  oldPath?: string;
  changeType: string;
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

type ImportPlan = {
  files: string[];
  folders: string[];
  conflicts: { path: string; reason: string }[];
  noteCount: number;
};

type Share = {
  id: string;
  notePath: string;
  slug: string;
  url: string;
  commitSha: string;
  active: boolean;
  createdAt: string;
  content?: string;
  fileVersion?: string;
};

type AuthState =
  | { status: "loading"; token: string | null; user: null }
  | { status: "anonymous"; token: null; user: null }
  | { status: "ready"; token: string; user: PublicUser };

type ToolTab = "version" | "search" | "transfer" | "shares" | "admin";

class ApiClientError extends Error {
  constructor(
    readonly code: ErrorCode | "UNKNOWN",
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const tokenStorageKey = "cloud-markdown-notes-token";

const errorMessages: Record<ErrorCode | "UNKNOWN", string> = {
  UNAUTHENTICATED: "Please log in again.",
  FORBIDDEN: "You do not have permission for that action.",
  USER_PENDING: "Your account is waiting for administrator activation.",
  USER_ALREADY_EXISTS: "That username is already registered.",
  USER_NOT_FOUND: "User not found.",
  INVALID_CREDENTIALS: "Invalid username or password.",
  VALIDATION_ERROR: "Required input is missing or invalid.",
  PATH_INVALID: "The path is invalid.",
  PATH_NOT_FOUND: "The path was not found.",
  PATH_ALREADY_EXISTS: "A file or folder already exists at that path.",
  NOTE_LIMIT_EXCEEDED: "This account has reached the note limit.",
  EDIT_CONFLICT: "The note changed on the server. Reload it before saving again.",
  COMMIT_MESSAGE_REQUIRED: "Commit message is required.",
  NO_CHANGES_TO_COMMIT: "There are no changes to commit.",
  IMPORT_CONFLICT: "The zip import has conflicts.",
  GLOB_INVALID: "The glob pattern is invalid.",
  REGEX_INVALID: "The regular expression is invalid.",
  NOTE_NOT_COMMITTED: "Only committed notes without draft changes can be shared.",
  SHARE_NOT_FOUND: "Share not found.",
  INTERNAL_ERROR: "The server returned an internal error.",
  UNKNOWN: "The request failed."
};

async function apiJson<T>(
  pathname: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    rawBody?: BodyInit;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const url = new URL(pathname, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    ...options.headers
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  } else if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as ApiSuccess<T> | ApiError) : undefined;

  if (!response.ok) {
    const apiError = isApiError(parsed) ? parsed.error : undefined;
    throw new ApiClientError(
      apiError?.code ?? "UNKNOWN",
      apiError?.message ?? `HTTP ${response.status}`,
      response.status
    );
  }

  return (parsed as ApiSuccess<T>).data;
}

function isApiError(value: unknown): value is ApiError {
  return !!value && typeof value === "object" && "error" in value;
}

function toMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return errorMessages[error.code] ?? error.message;
  }

  return error instanceof Error ? error.message : errorMessages.UNKNOWN;
}

export function App() {
  const slug = window.location.pathname.match(/^\/s\/([^/]+)$/)?.[1];
  if (slug) {
    return <PublicSharePage slug={slug} />;
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [auth, setAuth] = useState<AuthState>({
    status: "loading",
    token: window.localStorage.getItem(tokenStorageKey),
    user: null
  });

  useEffect(() => {
    let cancelled = false;
    const token = window.localStorage.getItem(tokenStorageKey);
    if (!token) {
      setAuth({ status: "anonymous", token: null, user: null });
      return;
    }

    apiJson<{ user: PublicUser }>("/api/auth/me", { token })
      .then(({ user }) => {
        if (!cancelled) {
          setAuth({ status: "ready", token, user });
        }
      })
      .catch(() => {
        window.localStorage.removeItem(tokenStorageKey);
        if (!cancelled) {
          setAuth({ status: "anonymous", token: null, user: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.status === "loading") {
    return <main className="center-screen">Loading...</main>;
  }

  if (auth.status === "anonymous") {
    return (
      <AuthPage
        onLogin={(token, user) => {
          window.localStorage.setItem(tokenStorageKey, token);
          setAuth({ status: "ready", token, user });
        }}
      />
    );
  }

  return (
    <WorkspacePage
      token={auth.token}
      user={auth.user}
      onLogout={() => {
        window.localStorage.removeItem(tokenStorageKey);
        setAuth({ status: "anonymous", token: null, user: null });
      }}
    />
  );
}

function AuthPage({ onLogin }: { onLogin: (token: string, user: PublicUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (mode === "register") {
        const { user } = await apiJson<{ user: PublicUser }>("/api/auth/register", {
          method: "POST",
          body: { username, password }
        });
        setMessage(`${user.username} is waiting for administrator activation.`);
      } else {
        const result = await apiJson<{ token: string; user: PublicUser }>("/api/auth/login", {
          method: "POST",
          body: { username, password }
        });
        onLogin(result.token, result.user);
      }
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <form className="auth-panel" onSubmit={(event) => void submit(event)}>
        <h1>Notes</h1>
        <div className="segmented">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Register
          </button>
        </div>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Working..." : mode === "login" ? "Login" : "Register"}
        </button>
        {message && <p className="message">{message}</p>}
      </form>
    </main>
  );
}

function WorkspacePage({
  token,
  user,
  onLogout
}: {
  token: string;
  user: PublicUser;
  onLogout: () => void;
}) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<SelectedPath | null>(null);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [status, setStatus] = useState<GitChange[]>([]);
  const [diff, setDiff] = useState("");
  const [history, setHistory] = useState<Commit[]>([]);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [tab, setTab] = useState<ToolTab>("version");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [newNotePath, setNewNotePath] = useState("/note.md");
  const [newFolderPath, setNewFolderPath] = useState("/folder");
  const [moveFrom, setMoveFrom] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [restoreCommit, setRestoreCommit] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restoreType, setRestoreType] = useState<"file" | "folder">("file");
  const [globPattern, setGlobPattern] = useState("**/*.md");
  const [globResults, setGlobResults] = useState<SearchMatch[]>([]);
  const [grepPattern, setGrepPattern] = useState("");
  const [grepGlob, setGrepGlob] = useState("**/*.md");
  const [grepRegex, setGrepRegex] = useState(false);
  const [grepIgnoreCase, setGrepIgnoreCase] = useState(true);
  const [grepResults, setGrepResults] = useState<GrepMatch[]>([]);
  const [readPath, setReadPath] = useState("");
  const [readOffset, setReadOffset] = useState("");
  const [readLimit, setReadLimit] = useState("");
  const [readResult, setReadResult] = useState<Note | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [pendingUsers, setPendingUsers] = useState<PublicUser[]>([]);

  const hasDirtyEditor = selectedNote !== null && editorContent !== selectedNote.content;
  const currentPathLabel = selectedPath?.path ?? selectedNote?.path ?? "No note selected";

  async function refreshWorkspace() {
    const [{ tree: nextTree }, { changes }, { commits }, sharesData] = await Promise.all([
      apiJson<{ tree: TreeNode }>("/api/tree", { token }),
      apiJson<{ changes: GitChange[] }>("/api/version/status", { token }),
      apiJson<{ commits: Commit[] }>("/api/version/history", { token }),
      apiJson<{ shares: Share[] }>("/api/shares", { token })
    ]);
    setTree(nextTree);
    setStatus(changes);
    setHistory(commits);
    setShares(sharesData.shares);
  }

  useEffect(() => {
    void runAction(refreshWorkspace);
  }, []);

  async function runAction(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      if (success) {
        setMessage(success);
      }
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadNote(pathname: string) {
    const { note } = await apiJson<{ note: Note }>("/api/notes", {
      token,
      query: { path: pathname }
    });
    setSelectedPath({ path: note.path, type: "note" });
    setSelectedNote(note);
    setEditorContent(note.content);
    setReadPath(pathname);
    setRestorePath(pathname);
    setMoveFrom(pathname);
  }

  function selectFolder(pathname: string) {
    setSelectedPath({ path: pathname, type: "folder" });
    setSelectedNote(null);
    setEditorContent("");
    setRestorePath(pathname);
    setMoveFrom(pathname);
  }

  async function saveNote() {
    if (!selectedNote) {
      return;
    }

    const { note } = await apiJson<{ note: Note }>("/api/notes", {
      token,
      method: "PUT",
      query: { path: selectedNote.path },
      body: {
        content: editorContent,
        ifMatch: selectedNote.fileVersion
      }
    });
    setSelectedNote(note);
    setEditorContent(note.content);
    await refreshWorkspace();
  }

  async function createNote() {
    const { note } = await apiJson<{ note: Note }>("/api/notes", {
      token,
      method: "POST",
      body: { path: newNotePath, content: "" }
    });
    setSelectedPath({ path: note.path, type: "note" });
    setSelectedNote(note);
    setEditorContent(note.content);
    await refreshWorkspace();
  }

  async function createFolder() {
    await apiJson("/api/folders", {
      token,
      method: "POST",
      body: { path: newFolderPath }
    });
    await refreshWorkspace();
  }

  async function movePath() {
    const endpoint = moveFrom.endsWith(".md") ? "/api/notes/move" : "/api/folders/move";
    await apiJson(endpoint, {
      token,
      method: "PATCH",
      body: {
        fromPath: moveFrom,
        toPath: moveTo
      }
    });
    if (selectedNote?.path === moveFrom && moveTo.endsWith(".md")) {
      await loadNote(moveTo);
    }
    await refreshWorkspace();
  }

  async function deleteSelectedPath() {
    if (!selectedPath) {
      return;
    }

    if (selectedPath.type === "note") {
      await apiJson("/api/notes", {
        token,
        method: "DELETE",
        query: { path: selectedPath.path }
      });
    } else {
      await apiJson("/api/folders", {
        token,
        method: "DELETE",
        query: { path: selectedPath.path }
      });
    }

    setSelectedPath(null);
    setSelectedNote(null);
    setEditorContent("");
    await refreshWorkspace();
  }

  async function commitChanges() {
    const { commit } = await apiJson<{ commit: { sha: string; message: string } }>(
      "/api/version/commit",
      {
        token,
        method: "POST",
        body: { message: commitMessage }
      }
    );
    setCommitMessage("");
    await refreshWorkspace();
    setMessage(`Committed ${commit.sha.slice(0, 12)}`);
  }

  async function refreshDiff() {
    const { diff: nextDiff } = await apiJson<{ diff: string }>("/api/version/diff", { token });
    setDiff(nextDiff);
  }

  async function showCommit(commitSha: string) {
    const { show } = await apiJson<{ show: CommitDetail }>("/api/version/show", {
      token,
      query: { commit: commitSha }
    });
    setCommitDetail(show);
    setRestoreCommit(show.commit.sha);
  }

  async function discardChanges() {
    await apiJson("/api/version/discard", { token, method: "POST" });
    setSelectedPath(null);
    setSelectedNote(null);
    setEditorContent("");
    await refreshWorkspace();
  }

  async function restoreFromHistory() {
    await apiJson("/api/version/restore", {
      token,
      method: "POST",
      body: {
        commitSha: restoreCommit,
        path: restorePath,
        type: restoreType
      }
    });
    await refreshWorkspace();
  }

  async function runGlob() {
    const { matches } = await apiJson<{ matches: SearchMatch[] }>("/api/search/glob", {
      token,
      method: "POST",
      body: { pattern: globPattern }
    });
    setGlobResults(matches);
  }

  async function runGrep() {
    const { matches } = await apiJson<{ matches: GrepMatch[] }>("/api/search/grep", {
      token,
      method: "POST",
      body: {
        pattern: grepPattern,
        regex: grepRegex,
        ignoreCase: grepIgnoreCase,
        glob: grepGlob || undefined,
        context: 0
      }
    });
    setGrepResults(matches);
  }

  async function runRead() {
    const { note } = await apiJson<{ note: Note }>("/api/search/read", {
      token,
      query: {
        path: readPath,
        offset: readOffset || undefined,
        limit: readLimit || undefined
      }
    });
    setReadResult(note);
  }

  async function dryRunImport() {
    if (!importFile) {
      throw new Error("Choose a zip file first.");
    }
    const { plan } = await apiJson<{ plan: ImportPlan }>("/api/import/dry-run", {
      token,
      method: "POST",
      rawBody: importFile,
      headers: { "content-type": "application/zip" }
    });
    setImportPlan(plan);
  }

  async function applyImport() {
    if (!importFile) {
      throw new Error("Choose a zip file first.");
    }
    await apiJson("/api/import", {
      token,
      method: "POST",
      rawBody: importFile,
      headers: { "content-type": "application/zip" }
    });
    setImportPlan(null);
    await refreshWorkspace();
  }

  async function exportZip() {
    const response = await fetch("/api/export.zip", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      const parsed = (await response.json()) as ApiError;
      throw new ApiClientError(parsed.error.code, parsed.error.message, response.status);
    }

    const href = window.URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = href;
    link.download = "notes.zip";
    link.click();
    window.URL.revokeObjectURL(href);
  }

  async function publishShare() {
    const pathToShare = selectedNote?.path ?? readPath;
    await apiJson("/api/shares", {
      token,
      method: "POST",
      body: { path: pathToShare }
    });
    await refreshWorkspace();
  }

  async function unpublishShare(shareId: string) {
    await apiJson(`/api/shares/${encodeURIComponent(shareId)}`, {
      token,
      method: "DELETE"
    });
    await refreshWorkspace();
  }

  async function loadPendingUsers() {
    const { users } = await apiJson<{ users: PublicUser[] }>("/api/admin/users/pending", {
      token
    });
    setPendingUsers(users);
  }

  async function activateUser(userId: string) {
    await apiJson(`/api/admin/users/${encodeURIComponent(userId)}/activate`, {
      token,
      method: "POST"
    });
    await loadPendingUsers();
  }

  const tabs = useMemo<ToolTab[]>(
    () =>
      user.role === "admin"
        ? ["version", "search", "transfer", "shares", "admin"]
        : ["version", "search", "transfer", "shares"],
    [user.role]
  );

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="sidebar">
          <div className="brand-row">
            <h1>Notes</h1>
            <button className="ghost" onClick={onLogout}>
              Logout
            </button>
          </div>
          <p className="user-line">
            {user.username} · {user.role}
          </p>
          <div className="quick-create">
            <label>
              New note
              <input
                aria-label="New note"
                value={newNotePath}
                onChange={(event) => setNewNotePath(event.target.value)}
              />
            </label>
            <button onClick={() => void runAction(createNote, "Note created")} disabled={busy}>
              Create
            </button>
            <label>
              New folder
              <input
                aria-label="New folder"
                value={newFolderPath}
                onChange={(event) => setNewFolderPath(event.target.value)}
              />
            </label>
            <button onClick={() => void runAction(createFolder, "Folder created")} disabled={busy}>
              Mkdir
            </button>
          </div>
          <nav className="tree" aria-label="Workspace tree">
            {tree?.children?.length ? (
              tree.children.map((node) => (
                <TreeItem
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath?.path}
                  onSelectNote={(path) => void runAction(() => loadNote(path))}
                  onSelectFolder={selectFolder}
                />
              ))
            ) : (
              <p className="muted">Empty workspace</p>
            )}
          </nav>
        </aside>

        <section className="content">
          <header className="toolbar">
            <div>
              <strong>{currentPathLabel}</strong>
              {hasDirtyEditor && <span className="dirty">Unsaved</span>}
            </div>
            <div className="toolbar-actions">
              <button onClick={() => void runAction(refreshWorkspace)} disabled={busy}>
                Refresh
              </button>
              <button
                className="primary"
                onClick={() => void runAction(saveNote, "Saved")}
                disabled={!selectedNote || busy || !hasDirtyEditor}
              >
                Save
              </button>
              <button
                onClick={() => void runAction(deleteSelectedPath)}
                disabled={!selectedPath || busy}
              >
                Delete
              </button>
            </div>
          </header>

          {message && <div className="notice">{message}</div>}

          <div className="main-grid">
            <section className="editor-area">
              <div className="split-title">
                <span>Markdown</span>
                <span>Preview</span>
              </div>
              <div className="editor-preview">
                <textarea
                  aria-label="Markdown editor"
                  value={editorContent}
                  onChange={(event) => setEditorContent(event.target.value)}
                  disabled={!selectedNote}
                  spellCheck={false}
                />
                <MarkdownPreview content={editorContent} />
              </div>
            </section>

            <aside className="tool-panel">
              <div className="tabs">
                {tabs.map((name) => (
                  <button
                    key={name}
                    className={tab === name ? "active" : ""}
                    onClick={() => {
                      setTab(name);
                      if (name === "admin") {
                        void runAction(loadPendingUsers);
                      }
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>

              {tab === "version" && (
                <VersionTools
                  status={status}
                  diff={diff}
                  history={history}
                  commitDetail={commitDetail}
                  commitMessage={commitMessage}
                  restoreCommit={restoreCommit}
                  restorePath={restorePath}
                  restoreType={restoreType}
                  moveFrom={moveFrom}
                  moveTo={moveTo}
                  setCommitMessage={setCommitMessage}
                  setRestoreCommit={setRestoreCommit}
                  setRestorePath={setRestorePath}
                  setRestoreType={setRestoreType}
                  setMoveFrom={setMoveFrom}
                  setMoveTo={setMoveTo}
                  onCommit={() => void runAction(commitChanges)}
                  onRefreshDiff={() => void runAction(refreshDiff)}
                  onShowCommit={(commitSha) => void runAction(() => showCommit(commitSha))}
                  onDiscard={() => void runAction(discardChanges, "Changes discarded")}
                  onRestore={() => void runAction(restoreFromHistory, "Path restored")}
                  onMove={() => void runAction(movePath, "Path moved")}
                />
              )}

              {tab === "search" && (
                <SearchTools
                  globPattern={globPattern}
                  globResults={globResults}
                  grepPattern={grepPattern}
                  grepGlob={grepGlob}
                  grepRegex={grepRegex}
                  grepIgnoreCase={grepIgnoreCase}
                  grepResults={grepResults}
                  readPath={readPath}
                  readOffset={readOffset}
                  readLimit={readLimit}
                  readResult={readResult}
                  setGlobPattern={setGlobPattern}
                  setGrepPattern={setGrepPattern}
                  setGrepGlob={setGrepGlob}
                  setGrepRegex={setGrepRegex}
                  setGrepIgnoreCase={setGrepIgnoreCase}
                  setReadPath={setReadPath}
                  setReadOffset={setReadOffset}
                  setReadLimit={setReadLimit}
                  onGlob={() => void runAction(runGlob)}
                  onGrep={() => void runAction(runGrep)}
                  onRead={() => void runAction(runRead)}
                  onOpen={(path) => void runAction(() => loadNote(path))}
                />
              )}

              {tab === "transfer" && (
                <TransferTools
                  importPlan={importPlan}
                  setImportFile={setImportFile}
                  onDryRun={() => void runAction(dryRunImport)}
                  onImport={() => void runAction(applyImport, "Zip imported")}
                  onExport={() => void runAction(exportZip, "Zip exported")}
                />
              )}

              {tab === "shares" && (
                <ShareTools
                  shares={shares}
                  selectedPath={selectedNote?.path ?? readPath}
                  onPublish={() => void runAction(publishShare, "Share published")}
                  onUnpublish={(shareId) =>
                    void runAction(() => unpublishShare(shareId), "Share removed")
                  }
                />
              )}

              {tab === "admin" && (
                <AdminTools
                  pendingUsers={pendingUsers}
                  onReload={() => void runAction(loadPendingUsers)}
                  onActivate={(userId) =>
                    void runAction(() => activateUser(userId), "User activated")
                  }
                />
              )}
            </aside>
          </div>
        </section>
      </section>
    </main>
  );
}

function TreeItem({
  node,
  selectedPath,
  onSelectNote,
  onSelectFolder
}: {
  node: TreeNode;
  selectedPath?: string;
  onSelectNote: (path: string) => void;
  onSelectFolder: (path: string) => void;
}) {
  const isNote = node.type === "note";
  const isFolder = node.type === "folder";
  return (
    <div className="tree-node">
      <button
        className={`tree-item ${selectedPath === node.path ? "active" : ""}`}
        onClick={() => {
          if (isNote) {
            onSelectNote(node.path);
          } else if (isFolder) {
            onSelectFolder(node.path);
          }
        }}
      >
        <span>{isFolder ? "dir" : isNote ? "md" : "file"}</span>
        {node.name || node.path}
      </button>
      {node.children?.length ? (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelectNote={onSelectNote}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VersionTools(props: {
  status: GitChange[];
  diff: string;
  history: Commit[];
  commitDetail: CommitDetail | null;
  commitMessage: string;
  restoreCommit: string;
  restorePath: string;
  restoreType: "file" | "folder";
  moveFrom: string;
  moveTo: string;
  setCommitMessage: (value: string) => void;
  setRestoreCommit: (value: string) => void;
  setRestorePath: (value: string) => void;
  setRestoreType: (value: "file" | "folder") => void;
  setMoveFrom: (value: string) => void;
  setMoveTo: (value: string) => void;
  onCommit: () => void;
  onRefreshDiff: () => void;
  onShowCommit: (commitSha: string) => void;
  onDiscard: () => void;
  onRestore: () => void;
  onMove: () => void;
}) {
  return (
    <div className="tool-stack">
      <section>
        <h2>Status</h2>
        {props.status.length === 0 ? (
          <p className="muted">Clean</p>
        ) : (
          <ul className="dense-list">
            {props.status.map((change) => (
              <li key={`${change.changeType}-${change.path}`}>
                {change.changeType} {change.oldPath ? `${change.oldPath} -> ` : ""}
                {change.path}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="inline-actions">
        <input
          aria-label="Commit message"
          placeholder="Commit message"
          value={props.commitMessage}
          onChange={(event) => props.setCommitMessage(event.target.value)}
        />
        <button className="primary" onClick={props.onCommit}>
          Commit
        </button>
      </section>

      <section className="inline-actions">
        <button onClick={props.onRefreshDiff}>Diff</button>
        <button onClick={props.onDiscard}>Discard</button>
      </section>
      {props.diff && <pre className="diff-box">{props.diff}</pre>}

      <section>
        <h2>History</h2>
        <ul className="dense-list">
          {props.history.map((commit) => (
            <li key={commit.sha}>
              <button className="link-button" onClick={() => props.setRestoreCommit(commit.sha)}>
                {commit.sha.slice(0, 10)}
              </button>{" "}
              {commit.message}{" "}
              <button className="link-button" onClick={() => props.onShowCommit(commit.sha)}>
                Show
              </button>
            </li>
          ))}
        </ul>
      </section>

      {props.commitDetail && (
        <section>
          <h2>Commit</h2>
          <div className="commit-summary">
            <p>{props.commitDetail.commit.sha}</p>
            <p>{props.commitDetail.commit.committedAt}</p>
            <p>{props.commitDetail.commit.message}</p>
          </div>
          <pre className="commit-diff">{props.commitDetail.diff || "No diff"}</pre>
        </section>
      )}

      <section className="form-grid">
        <input
          aria-label="Restore commit"
          placeholder="Commit sha"
          value={props.restoreCommit}
          onChange={(event) => props.setRestoreCommit(event.target.value)}
        />
        <input
          aria-label="Restore path"
          placeholder="Path"
          value={props.restorePath}
          onChange={(event) => props.setRestorePath(event.target.value)}
        />
        <select
          aria-label="Restore type"
          value={props.restoreType}
          onChange={(event) => props.setRestoreType(event.target.value as "file" | "folder")}
        >
          <option value="file">file</option>
          <option value="folder">folder</option>
        </select>
        <button onClick={props.onRestore}>Restore</button>
      </section>

      <section className="form-grid">
        <input
          aria-label="Move from"
          placeholder="Move from"
          value={props.moveFrom}
          onChange={(event) => props.setMoveFrom(event.target.value)}
        />
        <input
          aria-label="Move to"
          placeholder="Move to"
          value={props.moveTo}
          onChange={(event) => props.setMoveTo(event.target.value)}
        />
        <button onClick={props.onMove}>Move</button>
      </section>
    </div>
  );
}

function SearchTools(props: {
  globPattern: string;
  globResults: SearchMatch[];
  grepPattern: string;
  grepGlob: string;
  grepRegex: boolean;
  grepIgnoreCase: boolean;
  grepResults: GrepMatch[];
  readPath: string;
  readOffset: string;
  readLimit: string;
  readResult: Note | null;
  setGlobPattern: (value: string) => void;
  setGrepPattern: (value: string) => void;
  setGrepGlob: (value: string) => void;
  setGrepRegex: (value: boolean) => void;
  setGrepIgnoreCase: (value: boolean) => void;
  setReadPath: (value: string) => void;
  setReadOffset: (value: string) => void;
  setReadLimit: (value: string) => void;
  onGlob: () => void;
  onGrep: () => void;
  onRead: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="tool-stack">
      <section className="inline-actions">
        <input
          aria-label="Glob pattern"
          value={props.globPattern}
          onChange={(event) => props.setGlobPattern(event.target.value)}
        />
        <button onClick={props.onGlob}>Glob</button>
      </section>
      <ul className="dense-list">
        {props.globResults.map((match) => (
          <li key={`${match.type}-${match.path}`}>
            {match.type === "note" ? (
              <button className="link-button" onClick={() => props.onOpen(match.path)}>
                {match.path}
              </button>
            ) : (
              match.path
            )}
          </li>
        ))}
      </ul>

      <section className="form-grid">
        <input
          aria-label="Search text"
          placeholder="Search text"
          value={props.grepPattern}
          onChange={(event) => props.setGrepPattern(event.target.value)}
        />
        <input
          aria-label="Search glob"
          placeholder="Glob"
          value={props.grepGlob}
          onChange={(event) => props.setGrepGlob(event.target.value)}
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={props.grepRegex}
            onChange={(event) => props.setGrepRegex(event.target.checked)}
          />
          Regex
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={props.grepIgnoreCase}
            onChange={(event) => props.setGrepIgnoreCase(event.target.checked)}
          />
          Ignore case
        </label>
        <button onClick={props.onGrep}>Grep</button>
      </section>
      <ul className="dense-list">
        {props.grepResults.map((match) => (
          <li key={`${match.path}-${match.lineNumber}-${match.line}`}>
            <button className="link-button" onClick={() => props.onOpen(match.path)}>
              {match.path}:{match.lineNumber}
            </button>{" "}
            {match.line}
          </li>
        ))}
      </ul>

      <section className="form-grid">
        <input
          aria-label="Read path"
          placeholder="Read path"
          value={props.readPath}
          onChange={(event) => props.setReadPath(event.target.value)}
        />
        <input
          aria-label="Read offset"
          placeholder="Offset"
          value={props.readOffset}
          onChange={(event) => props.setReadOffset(event.target.value)}
        />
        <input
          aria-label="Read limit"
          placeholder="Limit"
          value={props.readLimit}
          onChange={(event) => props.setReadLimit(event.target.value)}
        />
        <button onClick={props.onRead}>Read</button>
      </section>
      {props.readResult && <pre className="read-box">{props.readResult.content}</pre>}
    </div>
  );
}

function TransferTools(props: {
  importPlan: ImportPlan | null;
  setImportFile: (file: File | null) => void;
  onDryRun: () => void;
  onImport: () => void;
  onExport: () => void;
}) {
  return (
    <div className="tool-stack">
      <section className="inline-actions">
        <button onClick={props.onExport}>Export zip</button>
      </section>
      <section className="form-grid">
        <input
          aria-label="Import zip"
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => props.setImportFile(event.target.files?.[0] ?? null)}
        />
        <button onClick={props.onDryRun}>Dry run</button>
        <button className="primary" onClick={props.onImport}>
          Import
        </button>
      </section>
      {props.importPlan && (
        <div className="summary-box">
          <p>
            {props.importPlan.files.length} files, {props.importPlan.folders.length} folders,{" "}
            {props.importPlan.conflicts.length} conflicts
          </p>
          <ul className="dense-list">
            {props.importPlan.conflicts.map((conflict) => (
              <li key={`${conflict.path}-${conflict.reason}`}>
                {conflict.path}: {conflict.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ShareTools(props: {
  shares: Share[];
  selectedPath: string;
  onPublish: () => void;
  onUnpublish: (shareId: string) => void;
}) {
  return (
    <div className="tool-stack">
      <section className="inline-actions">
        <span className="share-path">{props.selectedPath || "No note selected"}</span>
        <button className="primary" onClick={props.onPublish} disabled={!props.selectedPath}>
          Publish
        </button>
      </section>
      <ul className="dense-list">
        {props.shares.map((share) => (
          <li key={share.id} className="share-row">
            <a href={share.url} target="_blank" rel="noreferrer">
              {share.notePath}
            </a>
            <button onClick={() => props.onUnpublish(share.id)}>Unpublish</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdminTools(props: {
  pendingUsers: PublicUser[];
  onReload: () => void;
  onActivate: (userId: string) => void;
}) {
  return (
    <div className="tool-stack">
      <button onClick={props.onReload}>Reload pending users</button>
      <ul className="dense-list">
        {props.pendingUsers.length === 0 && <li>No pending users</li>}
        {props.pendingUsers.map((user) => (
          <li key={user.id} className="share-row">
            <span>{user.username}</span>
            <button onClick={() => props.onActivate(user.id)}>Activate</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublicSharePage({ slug }: { slug: string }) {
  const [share, setShare] = useState<Share | null>(null);
  const [message, setMessage] = useState("Loading...");

  useEffect(() => {
    apiJson<{ share: Share }>(`/api/shares/public/${encodeURIComponent(slug)}`)
      .then(({ share }) => {
        setShare(share);
        setMessage("");
      })
      .catch((error) => setMessage(toMessage(error)));
  }, [slug]);

  return (
    <main className="public-page">
      <article className="public-note">
        {share ? (
          <>
            <header>
              <h1>{share.notePath}</h1>
              <p>{share.commitSha.slice(0, 12)}</p>
            </header>
            <MarkdownPreview content={share.content ?? ""} />
          </>
        ) : (
          <p>{message}</p>
        )}
      </article>
    </main>
  );
}

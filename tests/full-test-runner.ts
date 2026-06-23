import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

type Command = {
  name: string;
  args: string[];
  env?: Record<string, string>;
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://app:3000/api";
const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/data/workspaces";
const runnerRoot = path.resolve("runtime", "fulltest-docker", "runner");
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";

const commands: Command[] = [
  {
    name: "api full test",
    args: ["tsx", "tests/api/full-test.ts"]
  },
  {
    name: "cli full test",
    args: ["tsx", "tests/cli/full-test.ts"]
  },
  {
    name: "web full test",
    args: ["playwright", "test"]
  }
];

async function main(): Promise<void> {
  await step("reset test database", resetDatabase);
  await step("reset test workspace", resetWorkspace);
  await step("wait for API health", waitForHealth);

  for (const command of commands) {
    await step(command.name, () => runCommand(command));
  }

  await step("cleanup test data", async () => {
    await resetDatabase();
    await resetWorkspace();
    await cleanDirectoryContents(runnerRoot);
  });
  process.stdout.write("[full-test] passed\n");
}

async function resetDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("delete from shares");
    await pool.query("delete from sessions");
    await pool.query("delete from users where lower(username) <> lower($1)", [adminUsername]);
  } finally {
    await pool.end();
  }
}

async function resetWorkspace(): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await cleanDirectoryContents(workspaceRoot);
  await mkdir(runnerRoot, { recursive: true });
}

async function cleanDirectoryContents(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  await Promise.all(
    entries.map((entry) => rm(path.join(directory, entry), { recursive: true, force: true }))
  );
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/health`);
      const body = (await response.json()) as { data?: { status?: string; database?: string } };
      if (response.ok && body.data?.status === "ok" && body.data.database === "ok") {
        return;
      }
      lastError = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`API did not become healthy at ${apiBaseUrl}.\n${lastError}`);
}

async function runCommand(command: Command): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.args[0], command.args.slice(1), {
      stdio: "inherit",
      env: {
        ...process.env,
        ...command.env
      }
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command.name} exited with ${code ?? signal ?? "unknown"}.`));
    });
  });
}

async function step(name: string, action: () => Promise<void>): Promise<void> {
  process.stdout.write(`[full-test] ${name}\n`);
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[full-test] ${name} failed:\n${message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

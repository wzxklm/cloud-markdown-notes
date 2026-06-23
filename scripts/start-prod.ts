import { spawn } from "node:child_process";

type Child = ReturnType<typeof spawn>;

const commands = [
  { name: "api", args: ["dist-node/src/server/index.js"] },
  { name: "web", args: ["dist-node/scripts/serve-web.js"] }
];

const children = new Set<Child>();

for (const command of commands) {
  const child = spawn(process.execPath, command.args, {
    stdio: "inherit",
    env: process.env
  });
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    stopChildren();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

process.on("SIGINT", () => {
  stopChildren("SIGINT");
});

process.on("SIGTERM", () => {
  stopChildren("SIGTERM");
});

function stopChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const child of children) {
    child.kill(signal);
  }
}

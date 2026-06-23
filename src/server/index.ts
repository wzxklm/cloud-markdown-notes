import { buildApp } from "./app";
import { loadConfig } from "./config";
import { closeDatabase } from "./db";

const config = loadConfig();
const app = buildApp(config);

const shutdown = async () => {
  await app.close();
  await closeDatabase();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

await app.listen({
  host: "0.0.0.0",
  port: config.apiPort
});

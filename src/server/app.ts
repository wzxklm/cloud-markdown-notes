import cors from "@fastify/cors";
import Fastify from "fastify";
import type { ApiSuccess, HealthStatus } from "../shared/api";
import { apiSuccess } from "../shared/api";
import { apiError } from "../shared/errors";
import { ensureAdminUser, registerAuthRoutes } from "./auth";
import type { AppConfig } from "./config";
import { registerContentRoutes } from "./content";
import { getDatabase, type Database } from "./db";
import { registerExtensionRoutes } from "./extensions";
import { registerVersionRoutes } from "./version";
import { assertWorkspaceWritable, WorkspaceError } from "./workspace";

export type AppDependencies = {
  database?: Database;
};

export function buildApp(config: AppConfig, dependencies: AppDependencies = {}) {
  const app = Fastify({
    logger: config.appEnv !== "test"
  });
  const db = dependencies.database ?? getDatabase(config);

  void app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkspaceError) {
      void reply.status(error.statusCode).send(apiError(error.code, error.message));
      return;
    }

    app.log.error(error);
    void reply.status(500).send(apiError("INTERNAL_ERROR", "Internal server error."));
  });

  app.addHook("onReady", async () => {
    await ensureAdminUser(config, db);
  });

  app.get<{ Reply: ApiSuccess<HealthStatus> }>("/api/health", async () => {
    await db.query("select 1");
    const writable = await assertWorkspaceWritable(config.workspaceRoot);

    return apiSuccess({
      status: "ok",
      appEnv: config.appEnv,
      database: "ok",
      workspace: {
        root: config.workspaceRoot,
        writable
      }
    });
  });

  registerAuthRoutes(app, config, db);
  registerContentRoutes(app, config, db);
  registerVersionRoutes(app, config, db);
  registerExtensionRoutes(app, config, db);

  return app;
}

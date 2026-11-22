import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { apiSuccess } from "../shared/api";
import { apiError } from "../shared/errors";
import { hashSessionToken, makeAuthenticate } from "./auth";
import type { AppConfig } from "./config";
import type { Database } from "./db";

export function registerMcpKeyRoutes(app: FastifyInstance, config: AppConfig, db: Database) {
  const options = { preHandler: makeAuthenticate(config, db) };
  app.get("/api/mcp-keys", options, async (request) => {
    const keys = await db.query(
      'select id, name, created_at as "createdAt" from mcp_keys where user_id = $1 order by created_at desc',
      [request.currentUser!.id]
    );
    return apiSuccess({ keys: keys.rows });
  });

  app.post<{ Body: { name?: unknown } }>("/api/mcp-keys", options, async (request, reply) => {
    const name = request.body?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
      return reply.code(400).send(apiError("VALIDATION_ERROR", "Enter a key name of 1 to 100 characters."));
    }
    const secret = "notes_mcp." + randomBytes(32).toString("base64url");
    const linkToken = randomBytes(32).toString("base64url");
    const linkPath = "/mcp?link=" + linkToken;
    const key = await db.query(
      `insert into mcp_keys (id, user_id, name, token_hash, link_hash) values ($1, $2, $3, $4, $5)
       returning id, name, created_at as "createdAt"`,
      [randomUUID(), request.currentUser!.id, name.trim(), hashSessionToken(secret, config.sessionSecret), hashSessionToken(linkToken, config.sessionSecret)]
    );
    return reply.code(201).header("Cache-Control", "no-store").send(apiSuccess({ key: key.rows[0], secret, linkPath }));
  });

  app.delete<{ Params: { id: string } }>("/api/mcp-keys/:id", options, async (request, reply) => {
    await db.query("delete from mcp_keys where user_id = $1 and id::text = $2", [
      request.currentUser!.id, request.params.id
    ]);
    return reply.send(apiSuccess({}));
  });
}

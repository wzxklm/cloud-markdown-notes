import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { apiSuccess } from "../shared/api";
import { apiError } from "../shared/errors";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import { ensureUserGitWorkspace } from "./workspace";

const scryptAsync = promisify(scrypt);
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;

export type UserRole = "admin" | "user";
type UserStatus = "active" | "pending";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: Date | string;
  activated_at: Date | string | null;
};

type PublicUserRow = Omit<UserRow, "password_hash">;

export type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  activatedAt: string | null;
};

export type AuthenticatedUser = PublicUser & {
  sessionTokenHash: string;
};

type RegisterBody = {
  username?: unknown;
  password?: unknown;
};

type LoginBody = RegisterBody;

type ActivateParams = {
  userId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPublicUser(row: PublicUserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    activatedAt: row.activated_at ? toIsoString(row.activated_at) : null
  };
}

function readCredentials(
  body: RegisterBody | undefined
): { username: string; password: string } | undefined {
  if (!body) {
    return undefined;
  }

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return undefined;
  }

  const username = body.username.trim();
  const password = body.password;
  if (!username || !password || username.length > 100 || password.length > 200) {
    return undefined;
  }

  return { username, password };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [scheme, salt, expectedHash] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const expected = Buffer.from(expectedHash, "base64url");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashSessionToken(token: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(token).digest("hex");
}

async function findUserByUsername(db: Database, username: string): Promise<UserRow | undefined> {
  const result = await db.query<UserRow>(
    `
      select id, username, password_hash, role, status, created_at, activated_at
      from users
      where lower(username) = lower($1)
    `,
    [username]
  );

  return result.rows[0];
}

async function createUser(
  db: Database,
  username: string,
  password: string,
  role: UserRole,
  status: UserStatus,
  activatedAt: Date | null
): Promise<UserRow> {
  const passwordHash = await hashPassword(password);
  const result = await db.query<UserRow>(
    `
      insert into users (id, username, password_hash, role, status, activated_at)
      values ($1, $2, $3, $4, $5, $6)
      returning id, username, password_hash, role, status, created_at, activated_at
    `,
    [randomUUID(), username, passwordHash, role, status, activatedAt]
  );

  return result.rows[0];
}

async function updateAdminUser(
  db: Database,
  userId: string,
  username: string,
  password: string
): Promise<UserRow> {
  const passwordHash = await hashPassword(password);
  const result = await db.query<UserRow>(
    `
      update users
      set username = $1,
          password_hash = $2,
          role = 'admin',
          status = 'active',
          activated_at = coalesce(activated_at, now())
      where id = $3
      returning id, username, password_hash, role, status, created_at, activated_at
    `,
    [username, passwordHash, userId]
  );

  return result.rows[0];
}

export async function ensureAdminUser(config: AppConfig, db: Database): Promise<PublicUser> {
  const existing = await findUserByUsername(db, config.adminUsername);
  const admin = existing
    ? await updateAdminUser(db, existing.id, config.adminUsername, config.adminPassword)
    : await createUser(
        db,
        config.adminUsername,
        config.adminPassword,
        "admin",
        "active",
        new Date()
      );

  await ensureUserGitWorkspace(config.workspaceRoot, admin.id);
  return toPublicUser(admin);
}

async function registerUser(config: AppConfig, db: Database, body: RegisterBody) {
  const credentials = readCredentials(body);
  if (!credentials) {
    return {
      status: 400,
      body: apiError("VALIDATION_ERROR", "Username and password are required.")
    };
  }

  const existing = await findUserByUsername(db, credentials.username);
  if (existing) {
    return { status: 409, body: apiError("USER_ALREADY_EXISTS", "Username already exists.") };
  }

  const user = await createUser(
    db,
    credentials.username,
    credentials.password,
    "user",
    "pending",
    null
  );
  await ensureUserGitWorkspace(config.workspaceRoot, user.id);

  return {
    status: 201,
    body: apiSuccess({
      user: toPublicUser(user)
    })
  };
}

async function createSession(config: AppConfig, db: Database, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token, config.sessionSecret);
  const expiresAt = new Date(Date.now() + sessionTtlMs);

  await db.query(
    `
      insert into sessions (id, user_id, token_hash, expires_at)
      values ($1, $2, $3, $4)
    `,
    [randomUUID(), userId, tokenHash, expiresAt]
  );

  return token;
}

function publicCurrentUser(user: AuthenticatedUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    activatedAt: user.activatedAt
  };
}

async function loginUser(config: AppConfig, db: Database, body: LoginBody) {
  const credentials = readCredentials(body);
  if (!credentials) {
    return {
      status: 400,
      body: apiError("VALIDATION_ERROR", "Username and password are required.")
    };
  }

  const user = await findUserByUsername(db, credentials.username);
  if (!user || !(await verifyPassword(credentials.password, user.password_hash))) {
    return { status: 401, body: apiError("INVALID_CREDENTIALS", "Invalid username or password.") };
  }

  if (user.status !== "active") {
    return { status: 403, body: apiError("USER_PENDING", "User is pending activation.") };
  }

  await ensureUserGitWorkspace(config.workspaceRoot, user.id);
  const token = await createSession(config, db, user.id);

  return {
    status: 200,
    body: apiSuccess({
      token,
      user: toPublicUser(user)
    })
  };
}

function getBearerToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return undefined;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }

  return token;
}

export function requireCurrentUser(
  request: FastifyRequest,
  reply: FastifyReply
): AuthenticatedUser | undefined {
  const user = request.currentUser;
  if (!user) {
    void reply.status(401).send(apiError("UNAUTHENTICATED", "Authentication is required."));
    return undefined;
  }

  return user;
}

export function makeAuthenticate(config: AppConfig, db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = getBearerToken(request);
    if (!token) {
      void reply.status(401).send(apiError("UNAUTHENTICATED", "Authentication is required."));
      return;
    }

    const tokenHash = hashSessionToken(token, config.sessionSecret);
    const result = await db.query<UserRow>(
      `
        select u.id, u.username, u.password_hash, u.role, u.status, u.created_at, u.activated_at
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.expires_at > now()
      `,
      [tokenHash]
    );

    const user = result.rows[0];
    if (!user) {
      void reply.status(401).send(apiError("UNAUTHENTICATED", "Authentication is required."));
      return;
    }

    if (user.status !== "active") {
      void reply.status(403).send(apiError("USER_PENDING", "User is pending activation."));
      return;
    }

    request.currentUser = {
      ...toPublicUser(user),
      sessionTokenHash: tokenHash
    };
  };
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = requireCurrentUser(request, reply);
  if (!user) {
    return;
  }

  if (user.role !== "admin") {
    void reply.status(403).send(apiError("FORBIDDEN", "Admin permission is required."));
  }
}

async function listPendingUsers(db: Database): Promise<PublicUser[]> {
  const result = await db.query<PublicUserRow>(
    `
      select id, username, role, status, created_at, activated_at
      from users
      where role = 'user'
        and status = 'pending'
      order by created_at asc
    `
  );

  return result.rows.map(toPublicUser);
}

async function activateUser(config: AppConfig, db: Database, userId: string) {
  const result = await db.query<UserRow>(
    `
      update users
      set status = 'active',
          activated_at = coalesce(activated_at, now())
      where id = $1
        and role = 'user'
      returning id, username, password_hash, role, status, created_at, activated_at
    `,
    [userId]
  );

  const user = result.rows[0];
  if (!user) {
    return { status: 404, body: apiError("USER_NOT_FOUND", "User not found.") };
  }

  await ensureUserGitWorkspace(config.workspaceRoot, user.id);
  return {
    status: 200,
    body: apiSuccess({
      user: toPublicUser(user)
    })
  };
}

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, db: Database): void {
  const authenticate = makeAuthenticate(config, db);

  app.post<{ Body: RegisterBody }>("/api/auth/register", async (request, reply) => {
    const result = await registerUser(config, db, request.body);
    void reply.status(result.status).send(result.body);
  });

  app.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const result = await loginUser(config, db, request.body);
    void reply.status(result.status).send(result.body);
  });

  app.post(
    "/api/auth/logout",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      await db.query("delete from sessions where token_hash = $1", [user.sessionTokenHash]);
      return apiSuccess({ ok: true });
    }
  );

  app.get(
    "/api/auth/me",
    {
      preHandler: [authenticate]
    },
    async (request, reply) => {
      const user = requireCurrentUser(request, reply);
      if (!user) {
        return;
      }

      return apiSuccess({
        user: publicCurrentUser(user)
      });
    }
  );

  app.get(
    "/api/admin/users/pending",
    {
      preHandler: [authenticate, requireAdmin]
    },
    async () => {
      return apiSuccess({
        users: await listPendingUsers(db)
      });
    }
  );

  app.post<{ Params: ActivateParams }>(
    "/api/admin/users/:userId/activate",
    {
      preHandler: [authenticate, requireAdmin]
    },
    async (request, reply) => {
      const result = await activateUser(config, db, request.params.userId);
      void reply.status(result.status).send(result.body);
    }
  );
}

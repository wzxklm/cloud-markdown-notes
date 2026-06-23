import "dotenv/config";
import path from "node:path";

export type AppConfig = {
  appEnv: string;
  apiPort: number;
  webPort: number;
  databaseUrl: string;
  workspaceRoot: string;
  publicBaseUrl: string;
  sessionSecret: string;
  adminUsername: string;
  adminPassword: string;
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }

  return value;
}

export function loadConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required.");
  }

  const adminUsername = process.env.ADMIN_USERNAME;
  if (!adminUsername) {
    throw new Error("ADMIN_USERNAME is required.");
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD is required.");
  }

  return {
    appEnv: process.env.APP_ENV || "development",
    apiPort: readNumber("API_PORT", 3000),
    webPort: readNumber("WEB_PORT", 5173),
    databaseUrl,
    workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || "/data/workspaces"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:5173",
    sessionSecret,
    adminUsername,
    adminPassword
  };
}

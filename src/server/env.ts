import dotenv from "dotenv";

export function loadProcessEnv(): void {
  const dotenvPath = process.env.DOTENV_CONFIG_PATH ?? getDefaultDotenvPath(process.env.APP_ENV);
  if (!dotenvPath) {
    return;
  }

  dotenv.config({ path: dotenvPath });
}

function getDefaultDotenvPath(appEnv: string | undefined): string | undefined {
  if (appEnv === "production" || appEnv === "test") {
    return undefined;
  }

  return ".env.dev";
}

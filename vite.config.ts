import fs from "node:fs";
import react from "@vitejs/plugin-react";
import dotenv from "dotenv";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const envFile = process.env.DOTENV_CONFIG_PATH ?? ".env.dev";
  const env = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
  const apiPort = Number(process.env.API_PORT || env.API_PORT || 3000);
  const webPort = Number(process.env.WEB_PORT || env.WEB_PORT || 5173);
  const apiProxy = {
    "/api": {
      target: `http://127.0.0.1:${apiPort}`,
      changeOrigin: true
    }
  };

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: webPort,
      allowedHosts: ["app"],
      proxy: apiProxy
    },
    preview: {
      host: "0.0.0.0",
      port: webPort,
      allowedHosts: ["app"],
      proxy: apiProxy
    }
  };
});

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(env.API_PORT || process.env.API_PORT || 3000);
  const webPort = Number(env.WEB_PORT || process.env.WEB_PORT || 5173);
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

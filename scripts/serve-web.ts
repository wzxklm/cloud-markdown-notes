import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3000);
const distRoot = path.resolve("dist");
const indexPath = path.join(distRoot, "index.html");
const apiTarget = `http://127.0.0.1:${apiPort}`;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Internal server error.");
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (requestUrl.pathname.startsWith("/api/")) {
    proxyToApi(req, res, requestUrl);
    return;
  }

  const filePath = await resolveStaticPath(requestUrl.pathname);
  res.writeHead(200, {
    "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream"
  });
  await pipeline(createReadStream(filePath), res);
}

async function resolveStaticPath(pathname: string): Promise<string> {
  const decodedPath = decodeURIComponent(pathname);
  const candidate = path.resolve(distRoot, `.${decodedPath}`);
  if (!candidate.startsWith(`${distRoot}${path.sep}`) && candidate !== distRoot) {
    return indexPath;
  }

  try {
    const fileStat = await stat(candidate);
    if (fileStat.isFile()) {
      return candidate;
    }
  } catch {
    // Fall back to the SPA entry below.
  }

  return indexPath;
}

function proxyToApi(req: IncomingMessage, res: ServerResponse, requestUrl: URL): void {
  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiTarget);
  const proxyReq = httpRequest(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host
      }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Bad gateway.");
  });

  req.pipe(proxyReq);
}

server.listen(webPort, "0.0.0.0", () => {
  console.log(`Web server listening on 0.0.0.0:${webPort}`);
});

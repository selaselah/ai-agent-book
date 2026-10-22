import http from "node:http";
import { pathToFileURL } from "node:url";

const hopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardedHeaders(headers) {
  const excluded = new Set(hopHeaders);
  for (const name of (headers.connection ?? "").split(",")) {
    excluded.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

export function createGateway({ langfusePort = 3060, downloadPort = 3211 } = {}) {
  const server = http.createServer((request, response) => {
    // Match the raw path so routing and the upstream cannot disagree about URL normalization.
    const path = request.url.split("?", 1)[0];
    const isLangfuse = path === "/langfuse" || path.startsWith("/langfuse/");
    const isDownload = path === "/android" || path.startsWith("/android/");
    if (!isLangfuse && !isDownload) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Service offline\n");
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: isLangfuse ? langfusePort : downloadPort,
      method: request.method,
      path: request.url,
      headers: {
        ...forwardedHeaders(request.headers),
        host: "ai-tutor-helper.corp.youdao.com",
        "x-forwarded-host": "ai-tutor-helper.corp.youdao.com",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
      },
    }, (incoming) => {
      response.writeHead(incoming.statusCode, forwardedHeaders(incoming.headers));
      incoming.pipe(response);
      incoming.on("error", () => response.destroy());
      response.on("close", () => incoming.destroy());
    });
    upstream.setTimeout(600_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Upstream unavailable\n");
      }
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.requestTimeout = 600_000;
  server.headersTimeout = 60_000;
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createGateway().listen(Number(process.env.PORT ?? 3210), process.env.BIND ?? "0.0.0.0");
}

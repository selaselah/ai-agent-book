import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createGateway } from "./gateway.mjs";

async function listen(server, context) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("Langfuse preserves prefix, auth cookies, POST body and redirect", async (context) => {
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.url, "/langfuse/api/auth/callback/credentials?test=1");
    assert.equal(request.headers.host, "ai-tutor-helper.corp.youdao.com");
    assert.equal(request.headers["x-forwarded-proto"], "https");
    assert.equal(request.headers.cookie, "session=test");
    assert.equal(Buffer.concat(chunks).toString(), "test-body");
    response.writeHead(302, {
      Location: "/langfuse/project/test",
      "Set-Cookie": ["session=one; Secure; HttpOnly", "csrf=two; Secure"],
    });
    response.end();
  });
  const langfusePort = await listen(backend, context);
  const port = await listen(createGateway({ langfusePort }), context);
  const result = await fetch(`http://127.0.0.1:${port}/langfuse/api/auth/callback/credentials?test=1`, {
    method: "POST", body: "test-body", headers: { Cookie: "session=test" }, redirect: "manual",
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/langfuse/project/test");
  assert.equal(result.headers.getSetCookie().length, 2);
});

test("Android ranges remain intact; unrelated and lookalike paths stay offline", async (context) => {
  const backend = http.createServer((request, response) => {
    assert.equal(request.url, "/android/test.apk");
    assert.equal(request.headers.range, "bytes=2-4");
    response.writeHead(206, { "Content-Range": "bytes 2-4/10", "Content-Length": "3" });
    response.end("234");
  });
  const downloadPort = await listen(backend, context);
  const port = await listen(createGateway({ downloadPort }), context);
  const result = await fetch(`http://127.0.0.1:${port}/android/test.apk`, { headers: { Range: "bytes=2-4" } });
  assert.equal(result.status, 206);
  assert.equal(result.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await result.text(), "234");
  for (const path of ["/", "/02/", "/api/status", "/langfuse-other", "/android-other"]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 503);
  }
});

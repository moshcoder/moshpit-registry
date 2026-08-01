import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/moshpit-registry.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("CLI rejects invalid timeout values before making a request", () => {
  for (const value of [undefined, "0", "-1", "1.5", "1e3", "nope", "--json"]) {
    const args = ["resolve", "blue.eggs", "--timeout"];
    if (value !== undefined) args.push(value);
    const result = run(args);

    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /--timeout must be a positive integer in milliseconds/, value);
    assert.equal(result.stdout, "", value);
  }
});

test("CLI timeout aborts a slow self-hosted registry request", async (t) => {
  let requests = 0;
  let requestedUrl = "";
  const server = createServer((req, res) => {
    requests++;
    requestedUrl = req.url || "";
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ registered: true }));
    }, 3000);
    timer.unref();
    res.on("close", () => clearTimeout(timer));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const started = Date.now();
  const result = await runAsync([
    "resolve",
    "Blue.Eggs",
    "--registry",
    `http://127.0.0.1:${address.port}`,
    "--timeout",
    "500",
  ]);
  const elapsed = Date.now() - started;

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /the registry has no answer/);
  assert.equal(requests, 1);
  assert.match(requestedUrl, /name=blue\.eggs/);
  assert.ok(elapsed < 2000, `configured timeout took ${elapsed}ms`);
});

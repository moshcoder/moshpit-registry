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

test("resolve accepts multiple names and preserves single-name JSON", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    requests.push(name);
    res.setHeader("content-type", "application/json");
    if (name === "missing.eggs") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.end(JSON.stringify({
      name,
      registered: true,
      name_registered: true,
      target: name === "blue.eggs" ? "203.0.113.9" : null,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const single = await runAsync(["resolve", "blue.eggs", "--registry", registry, "--json"]);
  assert.equal(single.status, 0, single.stderr || single.stdout);
  assert.deepEqual(JSON.parse(single.stdout), {
    name: "blue.eggs",
    registered: true,
    name_registered: true,
    target: "203.0.113.9",
  });

  const missing = await runAsync(["resolve", "missing.eggs", "--registry", registry, "--json"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "");
  assert.equal(missing.stdout,
    "missing.eggs — the registry has no answer (unreachable, or not a Moshpit name)\n");

  requests.length = 0;
  const multiple = await runAsync([
    "resolve", "Blue.Eggs.", "missing.eggs", "blue.eggs",
    "--registry", registry, "--json",
  ]);
  assert.equal(multiple.status, 1, multiple.stderr || multiple.stdout);
  assert.equal(multiple.stderr, "");
  assert.deepEqual(JSON.parse(multiple.stdout), [
    {
      name: "Blue.Eggs.",
      result: {
        name: "blue.eggs",
        registered: true,
        name_registered: true,
        target: "203.0.113.9",
      },
    },
    { name: "missing.eggs", result: null },
    {
      name: "blue.eggs",
      result: {
        name: "blue.eggs",
        registered: true,
        name_registered: true,
        target: "203.0.113.9",
      },
    },
  ]);
  assert.deepEqual(requests.sort(), ["blue.eggs", "missing.eggs"],
    "normalized duplicates should share one in-flight request");
});

test("multi-name human output keeps input order", async (t) => {
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      name,
      registered: true,
      name_registered: true,
      target: name === "first.eggs" ? "203.0.113.1" : "203.0.113.2",
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runAsync([
    "resolve", "first.eggs", "second.eggs",
    "--registry", `http://127.0.0.1:${server.address().port}`,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.indexOf("first.eggs") < result.stdout.indexOf("second.eggs"));
  assert.match(result.stdout, /first\.eggs[\s\S]*points at\s+203\.0\.113\.1/);
  assert.match(result.stdout, /second\.eggs[\s\S]*points at\s+203\.0\.113\.2/);
});

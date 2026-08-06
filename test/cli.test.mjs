import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONCURRENCY } from "../lib/index.mjs";

const BIN = fileURLToPath(new URL("../bin/moshpit-registry.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

function runAsync(args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    if (input !== null) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin.end(input);
    }
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

test("CLI rejects invalid concurrency values before making a request", () => {
  for (const value of [undefined, "0", "-1", "1.5", "1e3", "65", "nope", "--json"]) {
    const args = ["resolve", "blue.eggs", "--concurrency"];
    if (value !== undefined) args.push(value);
    const result = run(args);

    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /--concurrency must be a positive integer/, value);
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

test("pins rejects unsupported kinds before requesting and normalizes supported kinds", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url);
    const kind = url.searchParams.get("kind");
    const pin = `${kind}-pin`;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pins: [pin], entries: [{ kind, pin }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const invalid = await runAsync([
    "pins", "blue.eggs", "SSH", "--registry", registry, "--json",
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.signal, null);
  assert.equal(invalid.stderr, "");
  assert.deepEqual(JSON.parse(invalid.stdout), {
    error: "unsupported pin kind \"SSH\" (expected tls or mtp)",
  });
  assert.equal(requests.length, 0, "an unsupported kind must fail before any registry request");

  for (const [input, expected] of [["TLS", "tls"], ["mTp", "mtp"]]) {
    const result = await runAsync([
      "pins", "Blue.Eggs", input, "--registry", registry, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      pins: [`${expected}-pin`],
      entries: [{ kind: expected, pin: `${expected}-pin` }],
    });
    const url = requests.at(-1);
    assert.equal(url.searchParams.get("name"), "blue.eggs");
    assert.equal(url.searchParams.get("kind"), expected);
  }
  assert.equal(requests.length, 2);
});

test("pins accepts multiple names and preserves ordered results", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const name = url.searchParams.get("name");
    const kind = url.searchParams.get("kind");
    requests.push({ name, kind });
    res.setHeader("content-type", "application/json");
    if (name === "missing.eggs") {
      res.end(JSON.stringify({ pins: [], entries: [] }));
      return;
    }
    const pin = `${name}-${kind}-pin`;
    res.end(JSON.stringify({ pins: [pin], entries: [{ kind, pin }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const result = await runAsync([
    "pins", "Blue.Eggs.", "missing.eggs", "blue.eggs",
    "--kind", "TLS", "--registry", registry, "--concurrency", "2", "--json",
  ]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const blue = {
    pins: ["blue.eggs-tls-pin"],
    entries: [{ kind: "tls", pin: "blue.eggs-tls-pin" }],
  };
  assert.deepEqual(JSON.parse(result.stdout), [
    { name: "Blue.Eggs.", result: blue },
    { name: "missing.eggs", result: null },
    { name: "blue.eggs", result: blue },
  ]);
  assert.deepEqual(requests.map(({ name }) => name).sort(), ["blue.eggs", "missing.eggs"]);
  assert.ok(requests.every(({ kind }) => kind === "tls"));

  const human = await runAsync([
    "pins", "first.eggs", "second.eggs", "--kind", "mtp",
    "--registry", registry,
  ]);
  assert.equal(human.status, 0, human.stderr || human.stdout);
  assert.equal(human.stderr, "");
  assert.equal(
    human.stdout,
    "first.eggs\n"
      + "  mtp  first.eggs-mtp-pin\n\n"
      + "second.eggs\n"
      + "  mtp  second.eggs-mtp-pin\n",
  );
});

test("pins rejects an unsupported --kind before requesting", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pins: ["unexpected"] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runAsync([
    "pins", "blue.eggs", "red.eggs", "--kind", "SSH",
    "--registry", `http://127.0.0.1:${server.address().port}`, "--json",
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "unsupported pin kind \"SSH\" (expected tls or mtp)",
  });
  assert.equal(requests, 0);
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

test("resolve reads an ordered batch from stdin with a stable JSON shape", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    requests.push(name);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      name,
      registered: true,
      name_registered: true,
      target: `${name}.target`,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runAsync([
    "resolve", "-", "--registry", `http://127.0.0.1:${server.address().port}`, "--json",
  ], " Blue.Eggs. \n\nblue.eggs\nred.eggs\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.map(({ name }) => name), ["Blue.Eggs.", "blue.eggs", "red.eggs"]);
  assert.equal(output.length, 3);
  assert.deepEqual(requests.sort(), ["blue.eggs", "red.eggs"]);
});

test("single-line resolve stdin still returns the batch JSON shape", async (t) => {
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name, registered: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runAsync([
    "resolve", "-", "--registry", `http://127.0.0.1:${server.address().port}`, "--json",
  ], "blue.eggs\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(Array.isArray(JSON.parse(result.stdout)));
  assert.equal(JSON.parse(result.stdout)[0].name, "blue.eggs");
});

test("pins reads stdin and keeps the legacy positional kind", async (t) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const name = url.searchParams.get("name");
    const kind = url.searchParams.get("kind");
    const pin = `${name}-${kind}-pin`;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pins: [pin], entries: [{ kind, pin }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runAsync([
    "pins", "-", "TLS", "--registry", `http://127.0.0.1:${server.address().port}`, "--json",
  ], "blue.eggs\nred.eggs\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.map(({ name }) => name), ["blue.eggs", "red.eggs"]);
  assert.ok(output.every(({ result: value }) => value.entries[0].kind === "tls"));
});

test("stdin rejects invalid batches before making registry requests", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ registered: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;

  const empty = await runAsync(["resolve", "-", "--registry", registry, "--json"], "\n\r\n");
  assert.equal(empty.status, 1);
  assert.equal(empty.stderr, "");
  assert.deepEqual(JSON.parse(empty.stdout), { error: "stdin did not contain any names" });

  const oversizedInput = Array.from({ length: 1001 }, () => "blue.eggs").join("\n");
  const oversized = await runAsync(["pins", "-", "--registry", registry, "--json"], oversizedInput);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stderr, "");
  assert.deepEqual(JSON.parse(oversized.stdout), {
    error: "stdin accepts at most 1000 non-empty names",
  });

  const tooManyBytes = await runAsync(
    ["resolve", "-", "--registry", registry, "--json"],
    "a".repeat(1024 * 1024 + 1),
  );
  assert.equal(tooManyBytes.status, 1);
  assert.deepEqual(JSON.parse(tooManyBytes.stdout), {
    error: "stdin accepts at most 1048576 bytes",
  });

  const mixed = await runAsync(
    ["resolve", "-", "blue.eggs", "--registry", registry, "--json"],
    "red.eggs\n",
  );
  assert.equal(mixed.status, 1);
  assert.deepEqual(JSON.parse(mixed.stdout), {
    error: '"-" must be the only name when reading stdin',
  });

  const control = await runAsync(
    ["pins", "-", "--registry", registry, "--json"],
    "blue\u001b[2J.eggs\n",
  );
  assert.equal(control.status, 1);
  assert.deepEqual(JSON.parse(control.stdout), {
    error: "stdin names must not contain control characters",
  });
  assert.equal(requests, 0);
});

test("large stdin JSON batches are fully flushed to a pipe", async (t) => {
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      name,
      registered: true,
      name_registered: true,
      target: `${name}.${"x".repeat(256)}`,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const names = Array.from({ length: 400 }, (_, index) => `name-${index}.eggs`).join("\n");
  const result = await runAsync([
    "resolve", "-", "--registry", `http://127.0.0.1:${server.address().port}`, "--json",
  ], names);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.length > 64 * 1024);
  assert.equal(JSON.parse(result.stdout).length, 400);
});

test("a downstream reader closing stdout does not print an EPIPE stack", async (t) => {
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name, registered: true, target: `${name}.target` }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      BIN,
      "resolve",
      "blue.eggs",
      "--registry",
      `http://127.0.0.1:${server.address().port}`,
      "--json",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
    child.stdout.destroy();
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});

test("batch resolve respects the configured concurrency and preserves order", async (t) => {
  let active = 0;
  let maxActive = 0;
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name");
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name,
        registered: true,
        name_registered: true,
        target: `${name}.target`,
      }));
      active--;
    }, 40);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const names = Array.from({ length: 6 }, (_, index) => `name-${index}.eggs`);
  const result = await runAsync([
    "resolve", ...names,
    "--registry", `http://127.0.0.1:${server.address().port}`,
    "--concurrency", "2",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(maxActive > 1, `expected parallel requests, saw ${maxActive}`);
  assert.ok(maxActive <= 2, `concurrency limit exceeded: ${maxActive}`);
  assert.deepEqual(JSON.parse(result.stdout).map(({ name }) => name), names);

  active = 0;
  maxActive = 0;
  const defaultNames = Array.from(
    { length: DEFAULT_CONCURRENCY + 4 },
    (_, index) => `default-${index}.eggs`,
  );
  const defaults = await runAsync([
    "resolve", ...defaultNames,
    "--registry", `http://127.0.0.1:${server.address().port}`,
    "--json",
  ]);

  assert.equal(defaults.status, 0, defaults.stderr || defaults.stdout);
  assert.equal(DEFAULT_CONCURRENCY, 8);
  assert.ok(maxActive > 1, `expected parallel requests, saw ${maxActive}`);
  assert.ok(
    maxActive <= DEFAULT_CONCURRENCY,
    `default concurrency limit exceeded: ${maxActive}`,
  );
  assert.deepEqual(JSON.parse(defaults.stdout).map(({ name }) => name), defaultNames);
});

#!/usr/bin/env node
// Ask the registry directly.
//
// Every other tool in the stack asks it through a client; this is that client
// with a shell in front, for when the question is "what does the registry
// actually say" rather than "what did something do with the answer".

import { writeFileSync } from "node:fs";

import {
  createRegistry,
  DEFAULT_CONCURRENCY,
  DEFAULT_REGISTRY_BASE,
  DEFAULT_TIMEOUT_MS,
} from "../lib/index.mjs";

const USAGE = `moshpit-registry — ask the Moshpit registry

  moshpit-registry resolve (<name...> | -)   where names point; - reads stdin
  moshpit-registry pins (<name...> | -) [--kind tls|mtp]
                                             the keys names may present
  moshpit-registry tlds                     every ending claimed

  --registry URL    a self-hosted pit (default: ${DEFAULT_REGISTRY_BASE})
  --timeout MS      request deadline in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --concurrency N   maximum simultaneous batch lookups (default: ${DEFAULT_CONCURRENCY})
  --kind KIND       limit pins to tls or mtp
  --json            raw JSON instead of a summary`;

const args = process.argv.slice(2);
const [sub, ...rest] = args;
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const valueFlags = new Set(["--registry", "--timeout", "--concurrency", "--kind"]);
const MAX_BATCH_NAMES = 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_CONCURRENCY = 64;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const pinKinds = new Set(["tls", "mtp"]);
const positional = rest.filter((a, i) => !a.startsWith("--") && !valueFlags.has(rest[i - 1]));

if (!sub || sub === "help" || sub === "--help") { console.log(USAGE); process.exit(sub ? 0 : 1); }

const timeoutValue = flag("timeout", null);
if (args.includes("--timeout") && (
  !/^\d+$/.test(String(timeoutValue ?? ""))
  || !Number.isSafeInteger(Number(timeoutValue))
  || Number(timeoutValue) < 1
)) {
  console.error("moshpit-registry: --timeout must be a positive integer in milliseconds");
  process.exit(1);
}

const concurrencyValue = flag("concurrency", null);
if (args.includes("--concurrency") && (
  !/^\d+$/.test(String(concurrencyValue ?? ""))
  || !Number.isSafeInteger(Number(concurrencyValue))
  || Number(concurrencyValue) < 1
  || Number(concurrencyValue) > MAX_CONCURRENCY
)) {
  console.error(`moshpit-registry: --concurrency must be a positive integer no greater than ${MAX_CONCURRENCY}`);
  process.exit(1);
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;

  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  ));
  return results;
}

const raw = args.includes("--json");

async function commandNames(values) {
  const fromStdin = values.length === 1 && values[0] === "-";
  if (values.includes("-") && !fromStdin) {
    return {
      names: [],
      fromStdin: false,
      error: '"-" must be the only name when reading stdin',
    };
  }
  if (!fromStdin) return { names: values, fromStdin, error: null };

  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += data.length;
    if (byteLength > MAX_STDIN_BYTES) {
      return {
        names: [],
        fromStdin,
        error: `stdin accepts at most ${MAX_STDIN_BYTES} bytes`,
      };
    }
    chunks.push(data);
  }

  const names = [];
  for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (controlCharacters.test(name)) {
      return {
        names: [],
        fromStdin,
        error: "stdin names must not contain control characters",
      };
    }
    if (names.length === MAX_BATCH_NAMES) {
      return {
        names: [],
        fromStdin,
        error: `stdin accepts at most ${MAX_BATCH_NAMES} non-empty names`,
      };
    }
    names.push(name);
  }

  return {
    names,
    fromStdin,
    error: names.length ? null : "stdin did not contain any names",
  };
}

function printStdout(text) {
  try {
    writeFileSync(1, `${text}\n`);
  } catch (error) {
    // A downstream consumer such as `head` may close the pipe after it has
    // enough data. Match the previous console.log behavior for that benign
    // shell case while still surfacing real write failures.
    if (error?.code === "EPIPE") process.exit(0);
    throw error;
  }
}

function failInput(error) {
  if (raw) printStdout(JSON.stringify({ error }, null, 2));
  else console.error(`moshpit-registry: ${error}`);
  process.exit(1);
}

const registry = createRegistry({
  base: flag("registry", DEFAULT_REGISTRY_BASE),
  timeoutMs: timeoutValue === null ? DEFAULT_TIMEOUT_MS : Number(timeoutValue),
});

if (sub === "tlds") {
  const tlds = await registry.tlds();
  printStdout(raw ? JSON.stringify(tlds) : tlds.map((t) => `.${t}`).join("\n") || "no endings claimed");
  process.exit(0);
}

const name = positional[0];
if (!name) { console.error(`usage: moshpit-registry ${sub} <name>`); process.exit(1); }

if (sub === "resolve") {
  const { names, fromStdin, error } = await commandNames(positional);
  if (error) failInput(error);
  if (!names.length) { console.error("usage: moshpit-registry resolve <name>"); process.exit(1); }
  const concurrency = concurrencyValue === null
    ? DEFAULT_CONCURRENCY
    : Number(concurrencyValue);
  const results = await mapWithConcurrency(names, concurrency, async (requested) => ({
    name: requested,
    result: await registry.resolve(requested),
  }));

  // Preserve the established single-name failure text as well as its success
  // shape. Structured per-name nulls are only part of the new batch format.
  if (!fromStdin && results.length === 1 && !results[0].result) {
    printStdout(`${results[0].name} — the registry has no answer (unreachable, or not a Moshpit name)`);
    process.exit(1);
  }

  if (raw) {
    // Keep the established single-name shape. Multiple names need their input
    // beside each answer because a null result carries no name of its own.
    printStdout(JSON.stringify(!fromStdin && results.length === 1 ? results[0].result : results, null, 2));
  } else {
    const sections = results.map(({ name: requested, result }) => {
      if (!result) return `${requested} — the registry has no answer (unreachable, or not a Moshpit name)`;
      const lines = [
        requested,
        `  ending held    ${result.registered ? "yes" : "no"}`,
        `  name minted    ${result.name_registered ? "yes" : "no"}`,
        `  points at      ${result.target ?? "nothing yet"}`,
      ];
      if (result.resolved && result.resolved !== result.name) {
        lines.push(`  resolves to    ${result.resolved}  (aliased)`);
      }
      return lines.join("\n");
    });
    printStdout(sections.join("\n\n"));
  }
  process.exit(results.some(({ result }) => !result) ? 1 : 0);
}

if (sub === "pins") {
  const hasKindFlag = args.includes("--kind");
  const trailing = positional.at(-1);
  const legacyKind = !hasKindFlag
    && positional.length > 1
    && trailing !== "-"
    && (pinKinds.has(trailing.toLowerCase()) || !trailing.includes("."))
    ? trailing
    : null;
  const requestedKind = hasKindFlag ? flag("kind", null) : legacyKind;
  const kind = requestedKind ? requestedKind.toLowerCase() : null;
  if ((hasKindFlag && !requestedKind) || (kind && !pinKinds.has(kind))) {
    const error = `unsupported pin kind "${requestedKind ?? ""}" (expected tls or mtp)`;
    if (raw) printStdout(JSON.stringify({ error }, null, 2));
    else console.error(`moshpit-registry: ${error}`);
    process.exit(1);
  }

  const requestedNames = legacyKind ? positional.slice(0, -1) : positional;
  const { names, fromStdin, error } = await commandNames(requestedNames);
  if (error) failInput(error);
  if (!names.length) { console.error("usage: moshpit-registry pins <name>"); process.exit(1); }
  const concurrency = concurrencyValue === null
    ? DEFAULT_CONCURRENCY
    : Number(concurrencyValue);
  const results = await mapWithConcurrency(names, concurrency, async (requested) => ({
    name: requested,
    result: await registry.pins(requested, kind),
  }));

  if (!fromStdin && results.length === 1 && !results[0].result) {
    printStdout(`${results[0].name} — no key published${kind ? ` for ${kind}` : ""}`);
    process.exit(1);
  }

  if (raw) {
    printStdout(JSON.stringify(!fromStdin && results.length === 1 ? results[0].result : results, null, 2));
  } else {
    const sections = results.map(({ name: requested, result }) => {
      if (!result) return `${requested} — no key published${kind ? ` for ${kind}` : ""}`;
      const lines = [requested];
      for (const entry of result.entries || result.pins.map((pin) => ({ pin }))) {
        lines.push(`  ${entry.kind ? entry.kind.padEnd(4) : "    "} ${entry.pin}`);
      }
      return lines.join("\n");
    });
    printStdout(sections.join("\n\n"));
  }
  process.exit(results.some(({ result }) => !result) ? 1 : 0);
}

console.error(`unknown: ${sub}\n\n${USAGE}`);
process.exit(1);

#!/usr/bin/env node
// Ask the registry directly.
//
// Every other tool in the stack asks it through a client; this is that client
// with a shell in front, for when the question is "what does the registry
// actually say" rather than "what did something do with the answer".

import { createRegistry, DEFAULT_REGISTRY_BASE, DEFAULT_TIMEOUT_MS } from "../lib/index.mjs";

const USAGE = `moshpit-registry — ask the Moshpit registry

  moshpit-registry resolve <name...>     where names point, and who holds them
  moshpit-registry pins <name> [kind]    the keys a name may present (tls | mtp)
  moshpit-registry tlds                  every ending claimed

  --registry URL    a self-hosted pit (default: ${DEFAULT_REGISTRY_BASE})
  --timeout MS      request deadline in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --json            raw JSON instead of a summary`;

const args = process.argv.slice(2);
const [sub, ...rest] = args;
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const valueFlags = new Set(["--registry", "--timeout"]);
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

const registry = createRegistry({
  base: flag("registry", DEFAULT_REGISTRY_BASE),
  timeoutMs: timeoutValue === null ? DEFAULT_TIMEOUT_MS : Number(timeoutValue),
});
const raw = args.includes("--json");

if (sub === "tlds") {
  const tlds = await registry.tlds();
  console.log(raw ? JSON.stringify(tlds) : tlds.map((t) => `.${t}`).join("\n") || "no endings claimed");
  process.exit(0);
}

const name = positional[0];
if (!name) { console.error(`usage: moshpit-registry ${sub} <name>`); process.exit(1); }

if (sub === "resolve") {
  const results = await Promise.all(positional.map(async (requested) => ({
    name: requested,
    result: await registry.resolve(requested),
  })));

  // Preserve the established single-name failure text as well as its success
  // shape. Structured per-name nulls are only part of the new batch format.
  if (results.length === 1 && !results[0].result) {
    console.log(`${results[0].name} — the registry has no answer (unreachable, or not a Moshpit name)`);
    process.exit(1);
  }

  if (raw) {
    // Keep the established single-name shape. Multiple names need their input
    // beside each answer because a null result carries no name of its own.
    console.log(JSON.stringify(results.length === 1 ? results[0].result : results, null, 2));
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
    console.log(sections.join("\n\n"));
  }
  process.exit(results.some(({ result }) => !result) ? 1 : 0);
}

if (sub === "pins") {
  const requestedKind = positional[1] || null;
  const kind = requestedKind ? requestedKind.toLowerCase() : null;
  if (kind && !pinKinds.has(kind)) {
    const error = `unsupported pin kind "${requestedKind}" (expected tls or mtp)`;
    if (raw) console.log(JSON.stringify({ error }, null, 2));
    else console.error(`moshpit-registry: ${error}`);
    process.exit(1);
  }
  const p = await registry.pins(name, kind);
  if (!p) { console.log(`${name} — no key published${kind ? ` for ${kind}` : ""}`); process.exit(1); }
  if (raw) { console.log(JSON.stringify(p, null, 2)); process.exit(0); }
  console.log(`${name}`);
  for (const entry of p.entries || p.pins.map((pin) => ({ pin }))) {
    console.log(`  ${entry.kind ? entry.kind.padEnd(4) : "    "} ${entry.pin}`);
  }
  process.exit(0);
}

console.error(`unknown: ${sub}\n\n${USAGE}`);
process.exit(1);

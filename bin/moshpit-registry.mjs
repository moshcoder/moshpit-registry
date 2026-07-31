#!/usr/bin/env node
// Ask the registry directly.
//
// Every other tool in the stack asks it through a client; this is that client
// with a shell in front, for when the question is "what does the registry
// actually say" rather than "what did something do with the answer".

import { createRegistry, DEFAULT_REGISTRY_BASE } from "../lib/index.mjs";

const USAGE = `moshpit-registry — ask the Moshpit registry

  moshpit-registry resolve <name>        where a name points, and who holds it
  moshpit-registry pins <name> [kind]    the keys a name may present (tls | mtp)
  moshpit-registry tlds                  every ending claimed

  --registry URL    a self-hosted pit (default: ${DEFAULT_REGISTRY_BASE})
  --json            raw JSON instead of a summary`;

const args = process.argv.slice(2);
const [sub, ...rest] = args;
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const positional = rest.filter((a) => !a.startsWith("--") && a !== flag("registry", null));

if (!sub || sub === "help" || sub === "--help") { console.log(USAGE); process.exit(sub ? 0 : 1); }

const registry = createRegistry({ base: flag("registry", DEFAULT_REGISTRY_BASE) });
const raw = args.includes("--json");

if (sub === "tlds") {
  const tlds = await registry.tlds();
  console.log(raw ? JSON.stringify(tlds) : tlds.map((t) => `.${t}`).join("\n") || "no endings claimed");
  process.exit(0);
}

const name = positional[0];
if (!name) { console.error(`usage: moshpit-registry ${sub} <name>`); process.exit(1); }

if (sub === "resolve") {
  const r = await registry.resolve(name);
  if (!r) { console.log(`${name} — the registry has no answer (unreachable, or not a Moshpit name)`); process.exit(1); }
  if (raw) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`${name}`);
  console.log(`  ending held    ${r.registered ? "yes" : "no"}`);
  console.log(`  name minted    ${r.name_registered ? "yes" : "no"}`);
  console.log(`  points at      ${r.target ?? "nothing yet"}`);
  if (r.resolved && r.resolved !== r.name) console.log(`  resolves to    ${r.resolved}  (aliased)`);
  process.exit(0);
}

if (sub === "pins") {
  const kind = positional[1] || null;
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

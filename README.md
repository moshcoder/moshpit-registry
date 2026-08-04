# @moshcoder/moshpit-registry

Client for the Moshpit registry — resolve names, read key pins, list endings.

```sh
npm i @moshcoder/moshpit-registry
```

```js
import { createRegistry } from "@moshcoder/moshpit-registry";

const registry = createRegistry();
await registry.resolve("blue.eggs");   // where it points, and who holds the ending
await registry.pins("blue.eggs", "tls"); // the keys it may present
await registry.tlds();                  // every ending claimed
```

## Why it is a package

Three clients had grown independently — the resolver bridge, the pinning proxy,
and the browser extension. They agreed on the endpoints and disagreed on
everything that matters under load: which failures are cacheable, whether two
simultaneous lookups become one request, how long to wait before giving up.

## The distinction it is careful about

**A definite no is not an outage.** A `400` or `404` is an answer — the name is
malformed, or nobody has published a key — and is cached for as long as a real
answer. A timeout or a `500` is not, and is remembered only briefly so an outage
is not amplified into a flood.

A client that treats them alike either fails closed forever or fails open once,
and the second is how a namespace gets quietly defeated.

**An empty pin list is "no key published"**, not "any key will do".

## What it does under load

- **Bounded timeouts** — this sits in front of navigation, so a slow registry
  becomes a fast *no* rather than a hang
- **Cached**, so a page of names is not a page of requests
- **Coalesced**, so a client retrying a query it thinks was lost becomes one
  request rather than N
- **Failures return `null`** instead of throwing, because every caller here is
  deciding whether to connect, not whether to crash

## CLI

```sh
moshpit-registry resolve <name...>    where names point, and who holds them
moshpit-registry pins <name...> [--kind tls|mtp]
                                      the keys names may present
moshpit-registry tlds                 every ending claimed

--registry URL    a self-hosted pit
--timeout MS      request deadline in milliseconds (default: 8000)
--concurrency N   maximum simultaneous batch lookups (default: 8)
--kind KIND       limit pins to tls or mtp
--json            raw JSON instead of a summary
```

The optional `pins` kind is case-insensitive and must be `tls` or `mtp`. The
existing positional form remains available for one name (`pins blue.eggs tls`);
use `--kind` when inspecting a batch. Unsupported kinds are rejected before
contacting the registry; with `--json`, the validation failure is returned as
JSON.

The timeout applies to any registry request, including a self-hosted pit:

```sh
moshpit-registry resolve blue.eggs --registry http://127.0.0.1:8787 --timeout 2000
```

Pass more than one name to resolve a batch in one process. Requests run with a
default concurrency limit of 8, normalized duplicates share the client's
in-flight lookup, and results stay in input order. Use `--concurrency` to tune
the limit for a small self-hosted registry. With `--json`, multiple names
produce an array of `{ name, result }` records; the existing single-name JSON
shape is unchanged.

```sh
moshpit-registry resolve blue.eggs red.eggs missing.eggs --json
moshpit-registry resolve one.eggs two.eggs three.eggs --concurrency 2
```

`pins` accepts the same bounded batch workflow. Multiple names produce an
ordered array of `{ name, result }` records in JSON, while the established
single-name JSON shape stays unchanged. A missing pin makes the batch exit
non-zero without discarding the other answers.

```sh
moshpit-registry pins blue.eggs red.eggs --kind tls --json
```

```
$ moshpit-registry resolve california.oranges
california.oranges
  ending held    yes
  name minted    yes
  points at      nothing yet
```

## License

MIT.

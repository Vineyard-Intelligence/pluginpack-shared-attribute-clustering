# Shared-Attribute Clustering

A Vineyard **plugin pack** for **infrastructure attribution** — the CTI analogue of identity
resolution. Instead of "are these two accounts the same person?", it answers "does this
infrastructure belong to the same operator?". Pure graph analysis: no server, no API key, no network.

One plugin:

- **Shared-Attribute Clustering** (`run.vineyard.plugins.shared_attribute_clustering`) — links nodes
  that share a registrar or nameserver (Domain), announcing ASN (IP Address) or SHA-256 fingerprint
  (Certificate), and favicons that look alike (Favicon Hash), using the selected nodes or, with no
  selection, the whole graph:
  - Domains with the same **registrar** → `shared registrar: …`
  - Domains with the same **nameserver** → `shared nameserver: …`
  - IPs announced by the same **ASN** → `same ASN: …`
  - Certificates with the same **SHA-256 fingerprint** → `shared certificate: …`
  - Favicons whose **pHash or dHash** differ in at most 10 of 64 bits →
    `similar favicon: phash 3 bits, dhash 5 bits`

  Two nodes get one edge, naming every value they share:
  `shared registrar: …; shared nameserver: …, …`.

## How it works

- It reads only what other packs have already written onto nodes: a Domain's `registrar` and
  `name_servers` (**Domain Recon**), an IP Address's `asn` (for example **IP → ASN (Team Cymru)**),
  a TLS Certificate's `fingerprint_sha256` (for example **Censys**, **Shodan** or
  **VirusTotal**), and a Favicon Hash's `phash` and `dhash` (**Web Recon**). Run those first, then
  cluster to reveal who-owns-what.
- Members of each cluster are linked in a **star topology**. The edge between two members names
  every value they share, pivot by pivot in the order above, values sorted, at most four per pivot
  and then a count: one edge per pair is all the app keeps, so a pair on one registrar and two name
  servers is one edge that says all three.
- **Similar favicons are linked pair by pair**, because similarity is not transitive. Two hashes are
  compared by how many of their 64 bits differ (`src/hash-distance.ts`); the threshold is the
  `favicon_max_bits` parameter, 0–16, default 10 (Krawetz). A pair is linked when either hash is
  within it, since a small edit can move the pHash far while the dHash stays close. The label gives
  both distances, and the run summary states the threshold it used (and says so when a value
  outside 0–16 was clamped).
- **Over-common clusters are skipped** (more than 30 members): a value shared that widely isn't
  discriminating enough to imply shared operation. Low-signal attributes (country, bare
  organization) are intentionally excluded for the same reason. A favicon similar to 30 or more
  others (a default icon) is skipped the same way: with itself, that is a group of more than 30.
- **A hash at or near a blank icon's is never compared** (within 16 bits of the value every blank or
  single-colour icon hashes to). A symmetric logo's pHash lies there, so unrelated centred shapes
  would be "similar"; the favicon's other hash is still compared.
- Re-runnable, one edge per pair whichever way it points: a pair already linked is not linked again.
  An edge these pivots drew is relabelled, in its own direction, when what the pair shares changed
  (an older version's one-value label included); an edge with any other label is left alone and
  counted. Between two favicons, a `similar favicon` edge is relabelled only when the distances
  changed.
- Every pair of favicons is compared, so the cost grows with the square of their number: about half
  a second for 10,000 (`test-plugin.mjs` prints the timings).

Runs in capture mode by default, so the proposed links are **staged for your review** before they
touch the graph (human-in-the-loop).

## Layout

- `plugins/shared-attribute-clustering.manifest.json` — the pack manifest (catalog entry source),
  generated from the bundle by `gen-manifest.mjs`.
- `src/` — the source of the bundle. `src/hash-distance.ts` is a copy of the Vineyard app's own bit
  distance, so this pack and the app's AI agent agree on what "similar" means.
- `dist/` — runnable bundle.
- `test-plugin.mjs` — runs the built bundle against an in-memory graph.

No external data sources: attribution is derived entirely from attributes already on the graph.

## Building from source

`src/` is the source of `dist/pack.mjs`. The build pins esbuild, so the published bundle can be
checked against the source:

```bash
node build.mjs
git diff --exit-code dist/pack.mjs
```

After changing the source, regenerate the manifest from the bundle and run the tests:

```bash
node build.mjs && node gen-manifest.mjs && node test-plugin.mjs
```

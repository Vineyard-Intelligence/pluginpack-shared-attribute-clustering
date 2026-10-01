# Shared-Attribute Clustering

A Vineyard **plugin pack** for **infrastructure attribution** — the CTI analogue of identity
resolution. Instead of "are these two accounts the same person?", it answers "does this
infrastructure belong to the same operator?". Pure graph analysis: no server, no API key, no network.

One plugin:

- **Shared-Attribute Clustering** (`run.vineyard.plugins.shared_attribute_clustering`) — links nodes
  that share a registrar or nameserver (Domain), announcing ASN (IP Address) or SHA-256 fingerprint
  (Certificate), using the selected nodes or, with no selection, the whole graph:
  - Domains with the same **registrar** → `shared registrar: …`
  - Domains with the same **nameserver** → `shared nameserver: …`
  - IPs announced by the same **ASN** → `same ASN: …`
  - Certificates with the same **SHA-256 fingerprint** → `shared certificate: …`

## How it works

- It consumes the data the collection packs (**Domain Recon**, **IP Recon**, **Certificate
  Transparency**) write onto nodes — so run those first, then pivot to reveal who-owns-what.
- Members of each cluster are linked in a **star topology**; the shared value is in the edge label.
- **Over-common clusters are skipped** (more than 30 members): a value shared that widely isn't
  discriminating enough to imply shared operation. Low-signal attributes (country, bare
  organization) are intentionally excluded for the same reason.
- Re-runnable: existing `shared X` edges are not duplicated.

Runs in capture mode by default, so the proposed links are **staged for your review** before they
touch the graph (human-in-the-loop).

## Layout

- `plugins/shared-attribute-clustering.manifest.json` — the pack manifest (catalog entry source).
- `dist/` — runnable bundle.

No external data sources: attribution is derived entirely from attributes already on the graph.

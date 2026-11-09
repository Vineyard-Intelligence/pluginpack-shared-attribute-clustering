// Shared-Attribute Clustering — links infrastructure nodes that share a discriminating attribute.
//
// Groups the selected (or whole-graph) nodes by registrar, nameserver, announcing ASN or TLS
// certificate fingerprint and links the members of each cluster with a "shared X" edge.
//
// Pure graph analysis: no network, no new node types. It reads attributes other packs have already
// written onto the nodes.
import { definePlugin, definePluginPack } from './sdk';
import type { GraphNode, RunResult } from './sdk';

const MAX_GROUP = 30; // clusters larger than this are too common to be discriminating → skipped

const norm = (s: unknown) =>
    String(s ?? '')
        .trim()
        .toLowerCase();
const splitList = (s: unknown) =>
    String(s ?? '')
        .split(/[\n,;]+/)
        .map((x) => x.trim().toLowerCase().replace(/\.$/, ''))
        .filter(Boolean);

interface Pivot {
    key: string;
    label: string;
    typeIn: (t: string) => boolean;
    values: (d: any) => string[];
}

// High-signal attributes only — country_code / bare organization are deliberately excluded because
// they cluster far too broadly to imply shared operation.
const PIVOTS: Pivot[] = [
    {
        key: 'registrar',
        label: 'shared registrar',
        typeIn: (t) => t === 'infrastructure.domain',
        values: (d) => (d.registrar ? [norm(d.registrar)] : []),
    },
    {
        key: 'nameserver',
        label: 'shared nameserver',
        typeIn: (t) => t === 'infrastructure.domain',
        values: (d) => splitList(d.name_servers),
    },
    {
        key: 'asn',
        label: 'same ASN',
        typeIn: (t) => t === 'infrastructure.ip_address',
        values: (d) => (d.asn ? [norm(d.asn)] : []),
    },
    {
        key: 'certificate',
        label: 'shared certificate',
        typeIn: (t) => t === 'infrastructure.certificate',
        values: (d) => (d.fingerprint_sha256 ? [norm(d.fingerprint_sha256)] : []),
    },
];

const sharedAttributeClustering = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.shared_attribute_clustering',
        content_type: 'vineyard:plugin',
        name: 'Shared-Attribute Clustering',
        version: '1.1.1',
        description:
            'Links nodes that share a registrar or nameserver (Domain), announcing ASN (IP Address) or SHA-256 fingerprint (Certificate), using the selected nodes or, with no selection, the whole graph. Edges are labelled "shared registrar: <value>", "shared nameserver: <value>", "same ASN: <value>" or "shared certificate: <value>"; values shared by more than 30 nodes are skipped and existing edges are not duplicated. Uses only data already on the nodes.',
        icon: 'git-fork',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: { primary: 'web', web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' } },
        io: { consumes: [], produces: [] },
        scopes: { graph: ['node:read', 'edge:read', 'edge:create'] },
        lifecycle: { persistence: 'opt-in', controls: ['progress', 'cancel'], progress: 'determinate' },
    },
    async run(ctx): Promise<RunResult> {
        // Targets: the explicit selection if any, otherwise the whole graph.
        const sel = ctx.input.selection;
        let nodes: GraphNode[];
        if (sel && sel.length) {
            nodes = (await Promise.all(sel.map((id) => ctx.graph!.get!(id)))).filter(Boolean) as GraphNode[];
        } else {
            nodes = (await ctx.graph!.list!()).nodes;
        }
        if (nodes.length < 2)
            return { summary: 'Select at least two nodes (or run on a populated graph)', counts: { links: 0 } };

        // Existing edges → don't duplicate a "shared X" link on re-run (direction-insensitive).
        const edges = await ctx.graph!.edges!();
        const seen = new Set(edges.map((e) => `${e.from_node_id}\0${e.to_node_id}\0${e.label}`));
        const linked = (a: string, b: string, label: string) =>
            seen.has(`${a}\0${b}\0${label}`) || seen.has(`${b}\0${a}\0${label}`);

        let links = 0;
        let clusters = 0;
        let skipped = 0;
        for (let p = 0; p < PIVOTS.length; p++) {
            if (ctx.signal?.aborted) break;
            const pivot = PIVOTS[p];
            ctx.progress?.set?.({
                percent: Math.round(((p + 1) / PIVOTS.length) * 100),
                message: `Pivoting on ${pivot.key}`,
            });

            const byValue = new Map<string, string[]>();
            for (const n of nodes) {
                if (!pivot.typeIn(n.type)) continue;
                for (const v of pivot.values(n.data)) {
                    const arr = byValue.get(v) || [];
                    arr.push(String(n.id));
                    byValue.set(v, arr);
                }
            }
            for (const [value, ids] of byValue) {
                const uniq = [...new Set(ids)];
                if (uniq.length < 2) continue;
                if (uniq.length > MAX_GROUP) {
                    skipped++;
                    continue;
                }
                clusters++;
                // Star topology (member[0] ↔ others) keeps it O(n), not O(n²); the value in the
                // label makes the link readable regardless of edge direction.
                const label = `${pivot.label}: ${value.slice(0, 48)}`;
                for (let i = 1; i < uniq.length; i++) {
                    if (ctx.signal?.aborted) break;
                    if (linked(uniq[0], uniq[i], label)) continue;
                    await ctx.graph!.createEdge!({ from: uniq[0], to: uniq[i], label });
                    seen.add(`${uniq[0]}\0${uniq[i]}\0${label}`);
                    links++;
                }
            }
        }
        const note = skipped ? ` (${skipped} over-common cluster(s) skipped)` : '';
        return {
            summary: `${links} link(s) across ${clusters} shared-attribute cluster(s)${note}`,
            counts: { links, clusters },
        };
    },
});

// The pack's page, shown under the summary line when the pack is opened in the marketplace. It is
// Markdown rendered without images or raw HTML, and links show as text, so URLs are written out.
const PACK_PAGE = [
    'Infrastructure attribution from what the graph already holds. Where identity work asks whether two accounts belong to one person, this pack asks whether domains, IP addresses and certificates belong to one operator: it groups nodes by a discriminating attribute they have in common and links the members of each group. It is pure graph analysis, with no network request, no API key and no server.',
    '',
    '## Plugins',
    '',
    '### Shared-Attribute Clustering',
    '',
    '`run.vineyard.plugins.shared_attribute_clustering`',
    '',
    '- **Runs on:** the selected nodes, or every node in the graph when nothing is selected. At least two nodes are needed.',
    '- **Reads:** one property per pivot, each on one node type:',
    '',
    '| Pivot | Node type | Property | Edge label |',
    '|---|---|---|---|',
    '| Registrar | Domain (`infrastructure.domain`) | `registrar` | `shared registrar: <value>` |',
    '| Nameserver | Domain (`infrastructure.domain`) | `name_servers` | `shared nameserver: <value>` |',
    '| ASN | IP Address (`infrastructure.ip_address`) | `asn` | `same ASN: <value>` |',
    '| Certificate | TLS Certificate (`infrastructure.certificate`) | `fingerprint_sha256` | `shared certificate: <value>` |',
    '',
    '- **Adds:** edges only, labelled as above. It creates no nodes and changes no properties.',
    '- **Matching:** values are compared after trimming and lower-casing. `name_servers` is split on newlines, commas and semicolons, with a trailing dot dropped, so each nameserver forms its own group. The value in an edge label is cut to 48 characters.',
    '- **Star links:** a group is linked from its first member to each of the others, so a group of n nodes gets n - 1 edges rather than one per pair. The shared value is in the label, so an edge reads the same in either direction.',
    '- **Over-common values are skipped:** a value shared by more than 30 nodes is not linked, because a value that common does not suggest shared operation. The run summary counts the groups it skipped.',
    '- **Left out on purpose:** country and bare organization, which group far too broadly to imply shared operation.',
    '- **Re-runnable:** an edge with the same label between the same two nodes, in either direction, is not created again.',
    '- The proposed edges are staged for review before they reach the graph. The run reports progress and can be cancelled.',
    '',
    '## Requirements',
    '',
    '- No API key, account or Vineyard-operated service. Runs in the web app; the desktop app is not needed.',
    '- The properties in the table must already be on the nodes. Collection packs write them, so run those first: on a graph without them the plugin finds no groups.',
    '- Graph access: reads nodes and edges, creates edges.',
    '',
    '## What it contacts',
    '',
    'Nothing outside the project. It reads the nodes and edges already in the graph and creates edges between them. No query leaves the app, and no target is contacted.',
    '',
    '## Data and licences',
    '',
    'All input is data already in the project; the pack ships no data set of its own.',
    '',
    '## Source',
    '',
    'https://github.com/Vineyard-Intelligence/pluginpack-shared-attribute-clustering (Apache-2.0)',
    '',
    '`dist/pack.mjs` is built from `src/` with a pinned esbuild, so the published bundle can be checked against the source: `node build.mjs && git diff --exit-code dist/pack.mjs`.',
].join('\n');

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.shared_attribute_clustering',
    content_type: 'vineyard:pluginpack',
    name: 'Shared-Attribute Clustering',
    version: '1.2.0',
    summary:
        'Links infrastructure nodes that share a registrar, nameserver, ASN or TLS certificate, using data already in the graph.',
    description: PACK_PAGE,
    plugins: [sharedAttributeClustering],
});

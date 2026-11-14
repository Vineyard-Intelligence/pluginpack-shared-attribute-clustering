// Shared-Attribute Clustering — links infrastructure nodes that share a discriminating attribute.
//
// Groups the selected (or whole-graph) nodes by registrar, nameserver, announcing ASN or TLS
// certificate fingerprint and links the members of each cluster with one edge per pair naming every
// value the two share ("shared registrar: …; shared nameserver: …"), and links favicons whose
// perceptual hashes are a few bits apart with a "similar favicon" edge.
//
// Pure graph analysis: no network, no new node types. It reads attributes other packs have already
// written onto the nodes.
import { definePlugin, definePluginPack } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import { DEFAULT_MAX_BITS, MAX_BITS_CEILING, distanceOf, isLowInformationHash, parseHash64 } from './hash-distance';
import type { Hash64 } from './hash-distance';

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

// ---- similar favicons --------------------------------------------------------------------------
//
// Web Recon writes a favicon's pHash and dHash, and both are meant to be compared by how many of
// their 64 bits differ: a kit's icon re-encoded, resized or touched up by another deployment keeps
// a close hash and a different file hash, so the exact pivots above never join the two. The
// distance is hash-distance.ts, a copy of the app's own, so this pivot and the agent's
// similar_hashes tool cannot disagree about what "close" means.

const FAVICON_TYPE = 'web.favicon_hash';
const FAVICON_FIELDS = ['phash', 'dhash'] as const;
const FAVICON_LABEL = 'similar favicon';

/** Direction-insensitive: two nodes get one edge from this pack, whichever way it points. */
const pairKey = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

/** An edge already on a pair, as `edges()` gives it. */
interface PairEdge {
    from: string;
    to: string;
    label: string;
}

/** A label one of the exact pivots wrote, in this version's form or an older one's single value. */
const isPivotLabel = (label: string) => PIVOTS.some((p) => label.startsWith(`${p.label}: `));

/** Values per pivot shown in a label; the rest are counted. Domains rarely have more name servers. */
const SHOWN_VALUES = 4;

/**
 * "shared registrar: example registrar, inc.; shared nameserver: ns1.example, ns2.example" — every
 * discriminating value the two nodes share, pivot by pivot in PIVOTS order, values sorted so the
 * wording does not depend on the order a node lists them in.
 */
function sharedLabel(a: Map<string, Set<string>> | undefined, b: Map<string, Set<string>> | undefined): string {
    const parts: string[] = [];
    for (const pivot of PIVOTS) {
        const mine = a?.get(pivot.key);
        const theirs = b?.get(pivot.key);
        if (!mine || !theirs) continue;
        const both = [...mine].filter((v) => theirs.has(v)).sort();
        if (!both.length) continue;
        const shown = both.slice(0, SHOWN_VALUES).map((v) => v.slice(0, 48));
        const more = both.length - shown.length;
        parts.push(`${pivot.label}: ${shown.join(', ')}${more ? ` and ${more} more` : ''}`);
    }
    return parts.join('; ');
}

/** A pair of favicons within reach, by index into `ids`, with each hash's distance (-1: not both have it). */
interface FaviconPair {
    a: number;
    b: number;
    phash: number;
    dhash: number;
}

interface SimilarFavicons {
    ids: string[];
    pairs: FaviconPair[];
    /** Favicons within reach of MAX_GROUP or more others, whose pairs are all dropped. */
    overCommon: number;
    /** Favicons whose every hash is at or near a flat image's (isLowInformationHash), never compared. */
    uninformative: number;
    /** False when the run was cancelled part way, so `pairs` is incomplete. */
    complete: boolean;
}

/**
 * Every pair of favicons whose phash OR dhash differ by at most `maxBits`.
 *
 * Pairs, not a star: similarity is not transitive (A near B and B near C says nothing about A and
 * C), so there is no shared value to hang a group on the way the exact pivots do.
 *
 * Either hash, not both: a small edit moves them very differently (a corner square inverted moved
 * most public favicons' pHash more than 10 bits and their dHash at most 3), so requiring both would
 * miss the touched-up copy of a kit's icon. A value at or near a flat image's is never compared
 * (isLowInformationHash): a symmetric logo's pHash sits there, and with only the exact flat values
 * skipped, a disc, ring, plus, square and diamond were all linked to each other on phash while
 * their dHashes were 14 to 32 bits apart. The other hash of such a favicon is still compared.
 *
 * Every pair is compared, so the cost grows with the square of the favicon count. Measured with
 * test-plugin.mjs on random hashes (Node 22, Apple silicon): 25 ms for 2,000 favicons, 0.15 s for
 * 5,000 and 0.5 s for 10,000 (50 million pairs). `tick` yields between rows so a cancel is heard
 * and the progress bar moves.
 *
 * A favicon within reach of MAX_GROUP or more others is the over-common cluster of this pivot — a
 * framework's or a hosting panel's default icon — and every pair it is in is dropped: with itself it
 * makes more than MAX_GROUP alike, the size at which the exact pivots skip a value (31 Domains on one
 * registrar). Pairs are kept only while both ends are under the limit, so memory stays under
 * MAX_GROUP pairs per favicon however alike the icons are.
 */
async function similarFavicons(
    nodes: GraphNode[],
    maxBits: number,
    tick: (row: number, rows: number) => Promise<boolean>,
): Promise<SimilarFavicons> {
    const ids: string[] = [];
    const ph: Array<Hash64 | null> = [];
    const dh: Array<Hash64 | null> = [];
    const seenIds = new Set<string>();
    let uninformative = 0;
    for (const n of nodes) {
        const id = String(n.id);
        if (n.type !== FAVICON_TYPE || seenIds.has(id)) continue;
        seenIds.add(id);
        const [p, d] = FAVICON_FIELDS.map((f) => parseHash64(n.data?.[f]));
        const pOk = p && !isLowInformationHash(p) ? p : null;
        const dOk = d && !isLowInformationHash(d) ? d : null;
        if (!pOk && !dOk) {
            if (p || d) uninformative++;
            continue;
        }
        ids.push(id);
        ph.push(pOk);
        dh.push(dOk);
    }

    const near = new Uint32Array(ids.length);
    const pairs: FaviconPair[] = [];
    let complete = true;
    for (let i = 0; i < ids.length; i++) {
        if (!(await tick(i, ids.length))) {
            complete = false;
            break;
        }
        const pi = ph[i];
        const di = dh[i];
        for (let j = i + 1; j < ids.length; j++) {
            const pj = ph[j];
            const dj = dh[j];
            const pd = pi && pj ? distanceOf(pi, pj) : -1;
            const dd = di && dj ? distanceOf(di, dj) : -1;
            if (!((pd >= 0 && pd <= maxBits) || (dd >= 0 && dd <= maxBits))) continue;
            near[i]++;
            near[j]++;
            if (near[i] < MAX_GROUP && near[j] < MAX_GROUP) pairs.push({ a: i, b: j, phash: pd, dhash: dd });
        }
    }
    let overCommon = 0;
    for (const n of near) if (n >= MAX_GROUP) overCommon++;
    return {
        ids,
        pairs: pairs.filter((p) => near[p.a] < MAX_GROUP && near[p.b] < MAX_GROUP),
        overCommon,
        uninformative,
        complete,
    };
}

const bits = (n: number) => `${n} bit${n === 1 ? '' : 's'}`;

/** "similar favicon: phash 3 bits, dhash 12 bits" — both distances, so a pair close on one hash
 *  and far on the other reads as the weaker match it is. */
const faviconLabel = (p: FaviconPair) => {
    const parts = [p.phash >= 0 ? `phash ${bits(p.phash)}` : '', p.dhash >= 0 ? `dhash ${bits(p.dhash)}` : ''];
    return `${FAVICON_LABEL}: ${parts.filter(Boolean).join(', ')}`;
};

/**
 * The run's `favicon_max_bits`, clamped to what the form allows; the default when unset. Nothing
 * upstream enforces the form's bounds (the Run dialog's number box and invoke_plugin pass any value
 * through), so a value that was not used as given comes back with a note for the summary: a caller
 * who asked for 24 bits must not read the run as having linked everything within 24.
 */
function maxBitsParam(ctx: HostContext): { bits: number; note: string } {
    const raw = ctx.params?.favicon_max_bits;
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()))
        return { bits: DEFAULT_MAX_BITS, note: '' };
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n))
        return {
            bits: DEFAULT_MAX_BITS,
            note: `favicon_max_bits ${JSON.stringify(raw)?.slice(0, 40)} is not a number; ${DEFAULT_MAX_BITS} used`,
        };
    const bits = Math.min(MAX_BITS_CEILING, Math.max(0, Math.trunc(n)));
    if (bits === n) return { bits, note: '' };
    const why = n < 0 || n > MAX_BITS_CEILING ? `is outside 0–${MAX_BITS_CEILING}` : 'is not a whole number';
    return { bits, note: `favicon_max_bits ${n} ${why}; ${bits} used` };
}

const sharedAttributeClustering = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.shared_attribute_clustering',
        content_type: 'vineyard:plugin',
        name: 'Shared-Attribute Clustering',
        version: '1.2.0',
        description:
            'Links nodes that share a registrar or nameserver (Domain), announcing ASN (IP Address) or SHA-256 fingerprint (Certificate), and Favicon Hashes whose phash or dhash differ by at most 10 bits (adjustable), using the selected nodes or, with no selection, the whole graph. Two nodes get one edge naming every value they share, such as "shared registrar: <value>; shared nameserver: <value>, <value>", "same ASN: <value>" or "shared certificate: <value>", and two favicons "similar favicon: phash <n> bits, dhash <n> bits". Values shared by more than 30 nodes, favicons similar to 30 or more others and hashes at or near a blank icon\'s (blank, single-colour or symmetric icons) are skipped. A linked pair is not linked again: an edge this plugin drew is relabelled when what the pair shares changes, and any other is left as it is. Uses only data already on the nodes.',
        icon: 'git-fork',
        author: { name: 'VINEYARD', url: 'https://vineyard.run' },
        license: 'Apache-2.0',
        platforms: { primary: 'web', web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' } },
        io: { consumes: [], produces: [] },
        params: {
            type: 'object',
            properties: {
                favicon_max_bits: {
                    type: 'integer',
                    title: 'Similar favicon: most bits apart',
                    minimum: 0,
                    maximum: MAX_BITS_CEILING,
                    default: DEFAULT_MAX_BITS,
                    description: `Most bits of 64 a favicon's phash or dhash may differ by to count as similar, 0–${MAX_BITS_CEILING}. Default ${DEFAULT_MAX_BITS}, Krawetz's threshold for a likely variation.`,
                },
            },
        },
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

        // EXISTING EDGES, BY PAIR. The host keeps one edge per ordered pair and reads a create
        // against a linked pair as a proposal to relabel it, and the backend folds a second create
        // of a pair in one apply into the first as a duplicate. So this run proposes at most one
        // edge per pair of nodes, whichever way an edge already points, and the edge that is there
        // decides what that proposal is: nothing when it already says it, a relabel when one of
        // these pivots wrote it (what the pair shares changed, or an older version wrote one value
        // per edge), and nothing again when someone else wrote it (the analyst's own wording, most
        // likely). A relabel keeps the existing edge's direction, or it would be a second edge.
        //
        // Up to 1.2.1 every shared value was its own create. Two domains on one registrar and two
        // name servers got three creates for one pair; only the first, the registrar, landed, and
        // the name servers that made the link worth reading were dropped at apply as duplicates.
        // A re-run then proposed relabelling that edge to each name server in turn.
        const edges = await ctx.graph!.edges!();
        const byPair = new Map<string, PairEdge[]>();
        for (const e of edges) {
            const k = pairKey(String(e.from_node_id), String(e.to_node_id));
            const list = byPair.get(k) ?? [];
            list.push({ from: String(e.from_node_id), to: String(e.to_node_id), label: e.label ?? '' });
            byPair.set(k, list);
        }

        const steps = PIVOTS.length + 1; // the exact pivots, then similar favicons
        let links = 0;
        let clusters = 0;
        let skipped = 0;
        let sameLabel = 0;
        let otherLabel = 0;
        // What each node shares with a cluster, pivot by pivot: only values that formed a cluster
        // of 2 to MAX_GROUP, so an over-common value is in no label either.
        const kept = new Map<string, Map<string, Set<string>>>();
        // The pairs to link, in the order the stars first reach them.
        const pairs = new Map<string, { from: string; to: string }>();
        for (let p = 0; p < PIVOTS.length; p++) {
            if (ctx.signal?.aborted) break;
            const pivot = PIVOTS[p];
            ctx.progress?.set?.({
                percent: Math.round(((p + 1) / steps) * 100),
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
                for (const id of uniq) {
                    const byPivot = kept.get(id) ?? new Map<string, Set<string>>();
                    const values = byPivot.get(pivot.key) ?? new Set<string>();
                    values.add(value);
                    byPivot.set(pivot.key, values);
                    kept.set(id, byPivot);
                }
                // Star topology (member[0] ↔ others) keeps it O(n), not O(n²); the values in the
                // label make the link readable regardless of edge direction.
                for (let i = 1; i < uniq.length; i++) {
                    const k = pairKey(uniq[0], uniq[i]);
                    if (!pairs.has(k)) pairs.set(k, { from: uniq[0], to: uniq[i] });
                }
            }
        }
        for (const [k, pair] of pairs) {
            if (ctx.signal?.aborted) break;
            const label = sharedLabel(kept.get(pair.from), kept.get(pair.to));
            const have = byPair.get(k) ?? [];
            if (have.some((e) => e.label === label)) {
                sameLabel++;
                continue;
            }
            const ours = have.find((e) => isPivotLabel(e.label));
            if (have.length && !ours) {
                otherLabel++;
                continue;
            }
            const from = ours ? ours.from : pair.from;
            const to = ours ? ours.to : pair.to;
            await ctx.graph!.createEdge!({ from, to, label });
            byPair.set(k, [{ from, to, label }]);
            links++;
        }

        // Similar favicons, under the same one-edge-per-pair rule: a "similar favicon" edge is
        // relabelled only when the distances changed (the icons were hashed again), and any other
        // edge — the analyst's own wording, most likely — is left as it is.
        const { bits: maxBits, note: maxBitsNote } = maxBitsParam(ctx);
        let similar = 0;
        let alreadyLinked = 0;
        let fav: SimilarFavicons = { ids: [], pairs: [], overCommon: 0, uninformative: 0, complete: true };
        if (!ctx.signal?.aborted) {
            let last = Date.now();
            const base = Math.round((PIVOTS.length / steps) * 100);
            fav = await similarFavicons(nodes, maxBits, async (row, rows) => {
                if (ctx.signal?.aborted) return false;
                if (row > 0 && Date.now() - last < 100) return true;
                last = Date.now();
                ctx.progress?.set?.({
                    percent: base + Math.round((row / Math.max(rows, 1)) * (100 - base)),
                    message: `Comparing favicon hashes (${row} of ${rows})`,
                });
                // A macrotask, so the cancel message from the host can be delivered.
                await new Promise((r) => setTimeout(r, 0));
                return !ctx.signal?.aborted;
            });
            for (const pair of fav.pairs) {
                if (ctx.signal?.aborted) break;
                const from = fav.ids[pair.a];
                const to = fav.ids[pair.b];
                const label = faviconLabel(pair);
                const have = byPair.get(pairKey(from, to)) ?? [];
                const ours = have.find((e) => e.label.startsWith(`${FAVICON_LABEL}: `));
                if (have.some((e) => e.label === label) || (have.length && !ours)) {
                    alreadyLinked++;
                    continue;
                }
                const at = ours ?? { from, to };
                await ctx.graph!.createEdge!({ from: at.from, to: at.to, label });
                byPair.set(pairKey(from, to), [{ from: at.from, to: at.to, label }]);
                similar++;
                links++;
            }
        }

        const notes = [
            maxBitsNote,
            skipped ? `${skipped} over-common cluster(s) skipped` : '',
            sameLabel ? `${sameLabel} shared-attribute pair(s) already linked` : '',
            otherLabel ? `${otherLabel} shared-attribute pair(s) already linked under another label, left as they are` : '',
            fav.overCommon
                ? `${fav.overCommon} favicon(s) within ${maxBits} bits of ${MAX_GROUP} or more others skipped`
                : '',
            fav.uninformative ? `${fav.uninformative} favicon(s) too close to a blank icon's hash to compare` : '',
            alreadyLinked ? `${alreadyLinked} similar pair(s) already linked` : '',
            fav.complete && !ctx.signal?.aborted ? '' : 'cancelled before every favicon was compared',
        ].filter(Boolean);
        return {
            summary:
                `${links} link(s) across ${clusters} shared-attribute cluster(s) and ${similar} similar-favicon pair(s) within ${maxBits} bits` +
                (notes.length ? ` (${notes.join('; ')})` : ''),
            counts: { links, clusters, similar_favicons: similar },
        };
    },
});

// The pack's page, shown under the summary line when the pack is opened in the marketplace. It is
// Markdown rendered without images or raw HTML, and links show as text, so URLs are written out.
// The plugins, their node types and the permissions are listed right below it, so the page says
// only what that list does not: what the pack is for, who sees what, and how to read the results.
const PACK_PAGE = [
    'Infrastructure attribution from what the graph already holds. Where identity work asks whether two accounts belong to one person, this pack asks whether domains, IP addresses, certificates and favicons belong to one operator. Run it after collection.',
    '',
    "**Needs:** the attributes already on the nodes. Domain Recon writes a Domain's `registrar` and `name_servers`, an ASN pack such as IP → ASN (Team Cymru) an IP Address's `asn`, packs such as Censys, Shodan or VirusTotal a TLS Certificate's `fingerprint_sha256`, and Web Recon a Favicon Hash's `phash` and `dhash`. On a graph without them it finds no groups.",
    '',
    '**Who sees it:** no one. It queries no third party and contacts no target; every input is data already in the project.',
    '',
    '**Read results with care:**',
    '- A value shared by more than 30 nodes is skipped, because a value that common does not suggest shared operation; the run summary counts the skipped groups. Country and bare organization are left out for the same reason.',
    '- A group is linked as a star from its first member, so two other members of it have no edge between them. An edge names every value its two nodes share: read which before judging it.',
    '- Each nameserver forms its own group, so one domain can sit in several nameserver groups.',
    "- Similar favicons are linked pair by pair. Close on only one hash is the weaker match; a framework's default icon matches unrelated sites.",
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-shared-attribute-clustering (Apache-2.0)',
].join('\n');

export default definePluginPack({
    identifier: 'run.vineyard.pluginpacks.shared_attribute_clustering',
    content_type: 'vineyard:pluginpack',
    name: 'Shared-Attribute Clustering',
    version: '1.3.0',
    summary:
        'Links infrastructure nodes that share a registrar, nameserver, ASN or TLS certificate, and favicons that look alike, using data already in the graph.',
    description: PACK_PAGE,
    plugins: [sharedAttributeClustering],
});

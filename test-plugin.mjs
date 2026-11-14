#!/usr/bin/env node
// Runs the BUILT bundle's plugin against an in-memory graph. No network: the pack makes none.
//
//   node build.mjs && node test-plugin.mjs
//
// What it holds, through the plugin's real run():
//   · the exact pivots still group by value, as a star, and skip a value shared by more than 30;
//   · two nodes get ONE edge naming every value they share, because the host keeps one edge per
//     pair and drops a second create of a pair as a duplicate: two domains on one registrar and two
//     name servers used to get three creates, of which only the registrar's landed;
//   · an edge these pivots drew is relabelled, in its own direction, when what the pair shares
//     changed; an edge someone else wrote is left alone;
//   · similar favicons are linked pair by pair when phash OR dhash is within favicon_max_bits
//     (default 10, inclusive), labelled with both distances, never across a non-transitive gap;
//   · a favicon similar to 30 or more others is skipped — with itself that is a group of 31, the
//     size the exact pivots skip — and a hash at or near a blank icon's is never compared: blank and
//     single-colour icons hash alike, and a symmetric logo's pHash lies within a few bits of them,
//     so a disc, ring, plus, square and diamond were linked to one another on phash alone;
//   · a favicon_max_bits that was not used as given is named in the summary, which always states
//     the threshold the run used;
//   · a re-run adds nothing, an edge someone else wrote between two favicons is left alone, and a
//     "similar favicon" edge whose distances changed is relabelled;
//   · a cancel mid-way returns, and the run time for a few thousand favicons is printed, because
//     this pivot compares every pair.
//
// The hash values are Pillow and ImageHash's own, from Web Recon's test-fixtures/favicons, so the
// flat-image case is the reference library's value and not this code's assumption about it. The
// shapes are Web Recon's own phashHex and dhashHex on 32-px white-on-black drawings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pack = (await import('./dist/pack.mjs')).default;
const plugin = pack.plugins[0];
let fail = 0;
const check = (name, cond) => {
    console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}`);
    if (!cond) fail++;
};

const hex = (n) => n.toString(16).padStart(16, '0');
/** `h` with its lowest `bits` bits flipped: exactly `bits` apart. */
const flip = (h, bits) => hex(BigInt('0x' + h) ^ ((1n << BigInt(bits)) - 1n));
/** `h` with `bits` bits flipped starting at bit `from`. */
const flipAt = (h, from, bits) => hex(BigInt('0x' + h) ^ (((1n << BigInt(bits)) - 1n) << BigInt(from)));

// From pluginpack-web-recon/test-fixtures/favicons/expected.json (Pillow + ImageHash).
const ICO = { phash: 'a55a52cad29b931b', dhash: '6c9e9f9f9f9f9f9e' }; // ico-bmp32.ico
const PNG = { phash: 'eb3f90d0534aa8bc', dhash: '0101197dfefefefe' }; // png-rgba-48.png
const FLAT = { phash: '8000000000000000', dhash: '0000000000000000' }; // png-flat-1x1.png
// Centred, symmetric shapes: pHashes 6 to 9 bits from FLAT's and 1 to 10 from one another, dHashes
// 14 to 32 apart. Nothing alike.
const SHAPES = {
    disc: { phash: '8200280020008200', dhash: '007161c4c4617100' },
    ring: { phash: '82000a002000a200', dhash: '8271ccc4c4cc7182' },
    plus: { phash: '88002a00a2002800', dhash: '00b230f0f030b200' },
    square: { phash: '8200280028008200', dhash: '00e0c0e8e8c0e000' },
    diamond: { phash: '88002800a2000a00', dhash: '54b271cccc71b254' },
};

/**
 * The host's one-edge-per-ordered-pair rule, as far as these checks need it: a create against a pair
 * that has an edge is a relabel of that edge (host-bridge.ts createEdge), and a second create of a
 * pair in one run is a duplicate the backend drops at apply (core/bulk.py). `created` is every call.
 */
function graph(nodes, edges = []) {
    const created = [];
    const relabels = [];
    const duplicates = [];
    const staged = new Set();
    return {
        created,
        relabels,
        duplicates,
        api: {
            get: async (id) => nodes.find((n) => n.id === id) ?? null,
            list: async () => ({ nodes }),
            edges: async () => edges,
            createEdge: async (e) => {
                const from = String(e.from);
                const to = String(e.to);
                created.push({ from, to, label: e.label });
                const k = `${from}>${to}`;
                const live = edges.find((x) => x.from_node_id === from && x.to_node_id === to);
                if (staged.has(k)) duplicates.push(k);
                else if (live) relabels.push({ id: live.id, from: live.label, to: e.label });
                staged.add(k);
            },
        },
    };
}

async function runOn(nodes, { edges = [], selection = [], params = {}, signal, onProgress } = {}) {
    const g = graph(nodes, edges);
    const progress = [];
    const result = await plugin.run({
        run: { runId: 't', projectId: 'p', pluginId: plugin.manifest.identifier, platform: 'web' },
        input: { selection },
        params,
        graph: g.api,
        progress: {
            set: (p) => {
                progress.push(p);
                onProgress?.(p);
            },
        },
        signal,
    });
    return { result, created: g.created, relabels: g.relabels, duplicates: g.duplicates, progress };
}

const fav = (id, h) => ({ id, type: 'web.favicon_hash', data: { hash_value: String(id.length), ...h } });
const pairOf = (e) => [e.from, e.to].sort().join('~');
const labelFor = (created, a, b) => created.find((e) => pairOf(e) === [a, b].sort().join('~'))?.label;

// ---- the bundle and the catalog manifest agree ---------------------------------------------------
{
    const json = JSON.parse(
        readFileSync(new URL('./plugins/shared-attribute-clustering.manifest.json', import.meta.url)),
    );
    check("pack version in the JSON is the bundle's", json.version === pack.version);
    check(
        "summary and page in the JSON are the bundle's",
        json.summary === pack.summary && json.description === pack.description,
    );
    const { author, license, ...member } = plugin.manifest;
    check(
        "the member in the JSON is the bundle's (run node gen-manifest.mjs)",
        JSON.stringify(json.plugins[0]) === JSON.stringify(member),
    );
    check(
        'favicon_max_bits is declared 0–16, default 10',
        JSON.stringify(
            member.params?.properties?.favicon_max_bits && [
                member.params.properties.favicon_max_bits.minimum,
                member.params.properties.favicon_max_bits.maximum,
                member.params.properties.favicon_max_bits.default,
            ],
        ) === '[0,16,10]',
    );
}

// ---- the exact pivots are unchanged ----------------------------------------------------------------
{
    const dom = (id, registrar) => ({
        id,
        type: 'infrastructure.domain',
        data: { domain_name: `${id}.example`, registrar },
    });
    const crowd = Array.from({ length: 31 }, (_, i) => dom(`c${i}`, 'Huge Registrar'));
    const { result, created } = await runOn([
        dom('a', 'Small Registrar'),
        dom('b', 'small registrar '),
        dom('c', 'Small Registrar'),
        ...crowd,
    ]);
    const reg = created.filter((e) => e.label === 'shared registrar: small registrar');
    check(
        `a registrar group is a star from its first member (${reg.map(pairOf).join(' ')})`,
        reg.length === 2 && reg.every((e) => e.from === 'a'),
    );
    check(
        'a registrar shared by 31 is skipped and counted',
        !created.some((e) => e.label.includes('huge')) && /1 over-common cluster/.test(result.summary),
    );
}

// ---- one edge per pair, naming every value the two share ------------------------------------------
{
    const NS = 'ns1.dovrapark-dns.test\nns2.dovrapark-dns.test';
    const dom = (id, data) => ({ id, type: 'infrastructure.domain', data: { domain_name: `${id}.example`, ...data } });
    const both = [
        dom('d1', { registrar: 'Example Registrar, Inc.', name_servers: NS }),
        dom('d2', { registrar: 'Example Registrar, Inc.', name_servers: NS }),
    ];
    const LABEL = 'shared registrar: example registrar, inc.; shared nameserver: ns1.dovrapark-dns.test, ns2.dovrapark-dns.test';
    const first = await runOn(both);
    check(
        `a registrar and two name servers in common are one edge that names all three (${JSON.stringify(first.created)})`,
        first.created.length === 1 && first.created[0].label === LABEL && first.created[0].from === 'd1',
    );
    check('no create is a duplicate the backend would drop', first.duplicates.length === 0);
    check(
        `the summary counts one link across three clusters (${first.result.summary})`,
        /^1 link\(s\) across 3 shared-attribute cluster\(s\)/.test(first.result.summary),
    );

    const drawn = [{ id: 'e1', from_node_id: 'd1', to_node_id: 'd2', label: LABEL }];
    const again = await runOn(both, { edges: drawn });
    check(
        `a re-run proposes nothing (${JSON.stringify(again.created)})`,
        again.created.length === 0 && /1 shared-attribute pair\(s\) already linked/.test(again.result.summary),
    );

    // An older version's one-value edge, pointing the other way: relabelled where it is, not doubled.
    const old = [{ id: 'e2', from_node_id: 'd2', to_node_id: 'd1', label: 'shared registrar: example registrar, inc.' }];
    const upgraded = await runOn(both, { edges: old });
    check(
        `an older one-value edge is relabelled to name every shared value, in its own direction (${JSON.stringify(upgraded.created)})`,
        upgraded.created.length === 1 &&
            upgraded.relabels.length === 1 &&
            upgraded.relabels[0].id === 'e2' &&
            upgraded.relabels[0].to === LABEL,
    );
    const twice = await runOn(both, { edges: [{ ...old[0], label: LABEL }] });
    check('…and the next run leaves it alone: the label no longer flips', twice.created.length === 0);

    // What the pair shares changed: the edge is relabelled to the new set.
    const moved = [
        dom('d1', { registrar: 'Example Registrar, Inc.', name_servers: 'ns1.dovrapark-dns.test\nns3.dovrapark-dns.test' }),
        dom('d2', { registrar: 'Example Registrar, Inc.', name_servers: 'ns3.dovrapark-dns.test\nns1.dovrapark-dns.test' }),
    ];
    const changed = await runOn(moved, { edges: drawn });
    check(
        `when what the pair shares changes, its edge is relabelled to the new set (${JSON.stringify(changed.relabels)})`,
        changed.relabels.length === 1 &&
            changed.relabels[0].to === 'shared registrar: example registrar, inc.; shared nameserver: ns1.dovrapark-dns.test, ns3.dovrapark-dns.test',
    );

    // The analyst's own link between the two is theirs: left alone, and counted.
    const mine = await runOn(both, { edges: [{ id: 'e3', from_node_id: 'd1', to_node_id: 'd2', label: 'same operator (analyst)' }] });
    check(
        `an edge someone else wrote is left alone and counted (${mine.result.summary})`,
        mine.created.length === 0 && /1 shared-attribute pair\(s\) already linked under another label, left as they are/.test(mine.result.summary),
    );

    // An over-common value joins nobody and is in no label; the value that does join them is.
    const crowd = Array.from({ length: 31 }, (_, i) => dom(`c${i}`, { registrar: 'Huge Registrar' }));
    const narrow = await runOn([
        ...crowd,
        dom('x1', { registrar: 'Huge Registrar', name_servers: 'ns.small-host.test' }),
        dom('x2', { registrar: 'Huge Registrar', name_servers: 'ns.small-host.test' }),
    ]);
    check(
        `a registrar shared by more than 30 is left out of the label (${JSON.stringify(narrow.created)})`,
        narrow.created.length === 1 && narrow.created[0].label === 'shared nameserver: ns.small-host.test',
    );

    // Many shared name servers: four are named, the rest counted.
    const many = Array.from({ length: 6 }, (_, i) => `ns${i + 1}.big.test`).join(',');
    const lots = await runOn([dom('m1', { name_servers: many }), dom('m2', { name_servers: many })]);
    check(
        `more than four shared values are named up to four and counted (${lots.created[0]?.label})`,
        lots.created.length === 1 &&
            lots.created[0].label === 'shared nameserver: ns1.big.test, ns2.big.test, ns3.big.test, ns4.big.test and 2 more',
    );

    // Three domains on one registrar, two of them on one name server: the star from d-a reaches
    // d-b and d-c; d-b and d-c share the name server, and their edge says both.
    const tri = await runOn([
        dom('ta', { registrar: 'Small Registrar' }),
        dom('tb', { registrar: 'Small Registrar', name_servers: 'ns.shared.test' }),
        dom('tc', { registrar: 'Small Registrar', name_servers: 'ns.shared.test' }),
    ]);
    const lab = (a, b) => labelFor(tri.created, a, b);
    check(
        `each pair is linked once, with what that pair shares (${tri.created.map((e) => `${pairOf(e)}=${e.label}`).join(' | ')})`,
        tri.created.length === 3 &&
            tri.duplicates.length === 0 &&
            lab('ta', 'tb') === 'shared registrar: small registrar' &&
            lab('ta', 'tc') === 'shared registrar: small registrar' &&
            lab('tb', 'tc') === 'shared registrar: small registrar; shared nameserver: ns.shared.test',
    );
}

// ---- similar favicons ----------------------------------------------------------------------------
{
    const nodes = [
        fav('ico', ICO),
        // Disjoint bit ranges, so the variants are as far from each other as the sum of their flips.
        fav('ico-p10', { phash: flipAt(ICO.phash, 0, 10), dhash: flipAt(ICO.dhash, 0, 30) }), // phash at the limit
        fav('ico-d4', { phash: flipAt(ICO.phash, 10, 25), dhash: flipAt(ICO.dhash, 30, 4) }), // dhash alone
        fav('ico-11', { phash: flipAt(ICO.phash, 35, 11), dhash: flipAt(ICO.dhash, 34, 11) }), // one bit too far
        fav('png', PNG),
        fav('png-only-p', { phash: flip(PNG.phash, 3) }), // no dhash at all
        fav('flat-a', FLAT),
        fav('flat-b', FLAT),
        fav('broken', { phash: 'a55a52cad29b931', dhash: 'nothex' }),
        { id: 'dom', type: 'infrastructure.domain', data: { domain_name: 'x.example', ...ICO } },
    ];
    const { result, created, progress } = await runOn(nodes);
    const pairs = created
        .filter((e) => e.label.startsWith('similar favicon'))
        .map(pairOf)
        .sort();
    check(
        `pairs within 10 bits on either hash, and nothing else (${pairs.join(' ')})`,
        pairs.join(' ') ===
            ['ico~ico-p10', 'ico-d4~ico', 'png~png-only-p']
                .map((p) => p.split('~').sort().join('~'))
                .sort()
                .join(' '),
    );
    check(
        'the label gives both distances',
        labelFor(created, 'ico', 'ico-p10') === 'similar favicon: phash 10 bits, dhash 30 bits',
    );
    check(
        'and only the distance it has when one hash is missing',
        labelFor(created, 'png', 'png-only-p') === 'similar favicon: phash 3 bits',
    );
    check('two blank icons are not "similar" (flat hashes are never compared)', !labelFor(created, 'flat-a', 'flat-b'));
    check('only Favicon Hash nodes are compared', !created.some((e) => e.from === 'dom' || e.to === 'dom'));
    check(
        `the summary counts pairs and the blank icons, and states the threshold (${result.summary})`,
        result.counts.similar_favicons === 3 &&
            /3 similar-favicon pair\(s\) within 10 bits/.test(result.summary) &&
            /2 favicon\(s\) too close to a blank icon's hash to compare/.test(result.summary),
    );
    check(
        'progress reaches the favicon step',
        progress.some((p) => /favicon/.test(p.message ?? '')),
    );

    // Not transitive: a ~ b and b ~ c, with a and c 12 bits apart.
    const a = fav('a', { phash: ICO.phash });
    const b = fav('b', { phash: flipAt(ICO.phash, 0, 6) });
    const c = fav('c', { phash: flipAt(ICO.phash, 0, 12) });
    const chain = (await runOn([a, b, c])).created.map(pairOf).sort().join(' ');
    check(`similarity is linked pair by pair, not as a group (${chain})`, chain === 'a~b b~c');

    const strict = await runOn(nodes, { params: { favicon_max_bits: 4 } });
    check(
        'favicon_max_bits narrows it',
        strict.created.map(pairOf).sort().join(' ') === ['ico~ico-d4', 'png~png-only-p'].sort().join(' '),
    );
    const asText = await runOn(nodes, { params: { favicon_max_bits: '4' } });
    check('a numeric string is read as the number', asText.created.length === 2);
    const wide = await runOn(
        [
            fav('x', { phash: ICO.phash }),
            fav('y', { phash: flipAt(ICO.phash, 0, 16) }),
            fav('z', { phash: flipAt(ICO.phash, 16, 17) }),
        ],
        { params: { favicon_max_bits: 99 } },
    );
    check("a value past the form's maximum is clamped to 16", wide.created.map(pairOf).join() === 'x~y');
    check(
        `and the summary says so, and which threshold ran (${wide.result.summary})`,
        /favicon_max_bits 99 is outside 0–16; 16 used/.test(wide.result.summary) &&
            /pair\(s\) within 16 bits/.test(wide.result.summary),
    );
    const negative = await runOn(nodes, { params: { favicon_max_bits: -3 } });
    check(
        `a negative value is clamped to 0 and named (${negative.result.summary})`,
        /favicon_max_bits -3 is outside 0–16; 0 used/.test(negative.result.summary),
    );
    const fraction = await runOn(nodes, { params: { favicon_max_bits: 4.5 } });
    check(
        `a fraction is truncated and named (${fraction.result.summary})`,
        fraction.created.length === 2 && /favicon_max_bits 4\.5 is not a whole number; 4 used/.test(fraction.result.summary),
    );
    const word = await runOn(nodes, { params: { favicon_max_bits: 'ten' } });
    check(
        `a value that is not a number falls back to 10 and says so (${word.result.summary})`,
        word.created.length === 3 && /favicon_max_bits "ten" is not a number; 10 used/.test(word.result.summary),
    );
    const plain = await runOn(nodes, { params: { favicon_max_bits: 10 } });
    check(`a value used as given adds no note (${plain.result.summary})`, !/favicon_max_bits/.test(plain.result.summary));

    const selected = await runOn(nodes, { selection: ['ico', 'ico-d4', 'png'] });
    check(
        'a selection compares only what is selected',
        selected.created.map(pairOf).join() === ['ico', 'ico-d4'].sort().join('~'),
    );
}

// ---- symmetric icons ------------------------------------------------------------------------------
{
    const shapes = Object.entries(SHAPES).map(([id, h]) => fav(id, h));
    const { result, created } = await runOn(shapes);
    check(
        `a disc, ring, plus, square and diamond are not "similar" (${created.map((e) => e.label).join('; ')})`,
        created.length === 0 && result.counts.similar_favicons === 0,
    );
    // Their pHash is skipped, not the favicon: a re-encoded copy of one of them is found by dHash.
    const twin = fav('disc-twin', { phash: SHAPES.square.phash, dhash: flip(SHAPES.disc.dhash, 2) });
    const withTwin = await runOn([...shapes, twin]);
    check(
        `a symmetric icon's copy is still linked, on its dHash (${withTwin.created.map((e) => `${pairOf(e)} ${e.label}`).join('; ')})`,
        withTwin.created.length === 1 && labelFor(withTwin.created, 'disc', 'disc-twin') === 'similar favicon: dhash 2 bits',
    );
    const wide = await runOn(shapes, { params: { favicon_max_bits: 16 } });
    check(
        `even at 16 bits the shapes are not linked through their pHashes (${wide.created.map((e) => e.label).join('; ')})`,
        wide.created.every((e) => !/phash/.test(e.label)),
    );
}

// ---- a common default icon -----------------------------------------------------------------------
{
    const base = fav('default', PNG);
    const crowd = Array.from({ length: 31 }, (_, i) =>
        fav(`site${i}`, { phash: flipAt(PNG.phash, i % 40, 2), dhash: flipAt(PNG.dhash, 0, 30) }),
    );
    const loner = fav('loner', ICO);
    const lonerTwin = fav('loner-twin', { phash: flip(ICO.phash, 1), dhash: ICO.dhash });
    const { result, created } = await runOn([base, ...crowd, loner, lonerTwin]);
    const touchesDefault = created.filter((e) => e.from === 'default' || e.to === 'default');
    check(
        `a favicon similar to 30 or more others is skipped (${touchesDefault.length} edges touch it)`,
        touchesDefault.length === 0,
    );
    check(
        `and counted in the summary (${result.summary})`,
        /favicon\(s\) within 10 bits of 30 or more others skipped/.test(result.summary),
    );
    check(
        'an unrelated pair in the same run is still linked',
        labelFor(created, 'loner', 'loner-twin') === 'similar favicon: phash 1 bit, dhash 0 bits',
    );
}

// ---- the over-common line is the exact pivots' line ---------------------------------------------------
{
    // 31 Domains on one registrar are skipped (above); 31 favicons all alike must be too, and 30 not.
    const alike = (n) =>
        Array.from({ length: n }, (_, i) => fav(`a${i}`, { phash: flipAt(ICO.phash, i % 30, 1), dhash: ICO.dhash }));
    const of31 = await runOn(alike(31));
    check(
        `31 alike favicons are skipped, like 31 Domains on one registrar (${of31.created.length} edges)`,
        of31.created.length === 0 && /31 favicon\(s\) within 10 bits of 30 or more others skipped/.test(of31.result.summary),
    );
    const of30 = await runOn(alike(30));
    check(
        `30 alike are linked, every pair (${of30.created.length} edges)`,
        of30.created.length === (30 * 29) / 2 && !/others skipped/.test(of30.result.summary),
    );
}

// ---- re-runs and other writers' edges --------------------------------------------------------------
{
    const nodes = [
        fav('p', ICO),
        fav('q', { phash: flip(ICO.phash, 2), dhash: flip(ICO.dhash, 3) }),
        fav('r', { phash: flip(ICO.phash, 5), dhash: ICO.dhash }),
        fav('s', { phash: flip(ICO.phash, 7), dhash: ICO.dhash }),
    ];
    const first = await runOn(nodes);
    check(`first run links every close pair (${first.created.length})`, first.created.length === 6);
    const edges = first.created.map((e, i) => ({
        id: `e${i}`,
        from_node_id: e.from,
        to_node_id: e.to,
        label: e.label,
    }));
    const again = await runOn(nodes, { edges });
    check(
        `a re-run adds nothing (${again.created.length})`,
        again.created.length === 0 && /6 similar pair\(s\) already linked/.test(again.result.summary),
    );

    const analyst = edges.map((e) =>
        pairOf({ from: e.from_node_id, to: e.to_node_id }) === 'p~q'
            ? { ...e, label: 'same phishing kit (analyst)' }
            : e,
    );
    // The reversed direction must still count as the same pair.
    const reversed = analyst.map((e) =>
        pairOf({ from: e.from_node_id, to: e.to_node_id }) === 'p~r'
            ? { ...e, from_node_id: e.to_node_id, to_node_id: e.from_node_id }
            : e,
    );
    const kept = await runOn(nodes, { edges: reversed });
    check(
        'an edge someone else wrote between two similar favicons is left alone, either direction',
        kept.created.length === 0,
    );

    const stale = edges.map((e) =>
        pairOf({ from: e.from_node_id, to: e.to_node_id }) === 'p~s'
            ? { ...e, label: 'similar favicon: phash 9 bits, dhash 0 bits' }
            : e,
    );
    const relabel = await runOn(nodes, { edges: stale });
    check(
        `a "similar favicon" edge whose distances changed is relabelled (${JSON.stringify(relabel.created)})`,
        relabel.created.length === 1 && relabel.created[0].label === 'similar favicon: phash 7 bits, dhash 0 bits',
    );
    // …in the direction it already points, so it is a relabel and not a second edge the other way.
    const staleReversed = stale.map((e) =>
        pairOf({ from: e.from_node_id, to: e.to_node_id }) === 'p~s'
            ? { ...e, from_node_id: e.to_node_id, to_node_id: e.from_node_id }
            : e,
    );
    const turned = await runOn(nodes, { edges: staleReversed });
    check(
        `a reversed "similar favicon" edge is relabelled where it points (${JSON.stringify(turned.relabels)})`,
        turned.created.length === 1 && turned.relabels.length === 1 && turned.relabels[0].to === 'similar favicon: phash 7 bits, dhash 0 bits',
    );
}

// ---- cancel, and the cost of comparing every pair ----------------------------------------------------
{
    let seed = 0x2545f4914f6cdd1dn;
    const rand = () => {
        seed ^= seed << 13n;
        seed &= (1n << 64n) - 1n;
        seed ^= seed >> 7n;
        seed ^= seed << 17n;
        seed &= (1n << 64n) - 1n;
        return hex(seed);
    };
    const synthetic = (n) => Array.from({ length: n }, (_, i) => fav(`f${i}`, { phash: rand(), dhash: rand() }));

    // Cancelled from the progress callback the moment the favicon step reports, so the abort lands
    // while every pair is still to be compared, however fast this machine is.
    const ctl = new AbortController();
    const cancelled = await runOn(synthetic(4000), {
        signal: ctl.signal,
        onProgress: (p) => /favicon/.test(p.message ?? '') && ctl.abort(),
    });
    check(
        `a cancel mid-way returns and says so (${cancelled.result.summary})`,
        /cancelled before every favicon was compared/.test(cancelled.result.summary) &&
            cancelled.result.counts.similar_favicons === 0,
    );

    for (const n of [1000, 2000, 5000, 10000]) {
        const nodes = synthetic(n);
        const t = performance.now();
        const { result } = await runOn(nodes);
        const ms = performance.now() - t;
        console.log(
            `  time  ${n} favicons, ${((n * (n - 1)) / 2).toLocaleString('en')} pairs: ${Math.round(ms)} ms (${
                result.counts.similar_favicons
            } pairs linked)`,
        );
        if (n === 2000) check('2,000 favicons compare in under 5 s', ms < 5000);
    }
}

assert.ok(true);
if (fail) {
    console.error(`\n${fail} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');

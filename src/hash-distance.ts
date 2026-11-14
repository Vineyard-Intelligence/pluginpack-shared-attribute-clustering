// How far apart two 64-bit perceptual hashes are: the number of bits that differ (Hamming distance).
//
// web.favicon_hash carries `phash` and `dhash` as 16 hex digits, and the type and Web Recon's pack
// page both say they are compared by how many of their 64 bits differ, not by equality. Nothing
// compared them that way: find_nodes and the canvas search match substrings, and Shared-Attribute
// Clustering groups exact values only. So a phishing kit's favicon that had been re-encoded, resized
// or touched up never met its siblings, which is the one thing a perceptual hash is for.
//
// DEPENDENCY-FREE ON PURPOSE. The agent's similar_hashes tool imports it, check-hash-distance runs
// it directly, and pluginpack-shared-attribute-clustering keeps a copy in its own src/ (a pack is
// built from public source and cannot import app code). check-hash-distance fails when the two
// copies differ, so change both or neither.

/** Bits in the hashes this module compares: 16 hex digits. */
export const HASH64_BITS = 64;

/**
 * The default "close enough". Krawetz ("Kind of Like That", 2013) reads two hashes 1 to 10 bits
 * apart as likely variations of one picture, and Web Recon's pack page quotes the same figure.
 */
export const DEFAULT_MAX_BITS = 10;

/**
 * The widest distance a caller may ask for. Two unrelated 64-bit values differ in 32 bits on
 * average, and beyond about a quarter of the bits the answer stops meaning "the same picture" and
 * starts listing coincidences.
 */
export const MAX_BITS_CEILING = 16;

/** A parsed hash as its high and low 32 bits, so a distance is two XORs and two popcounts. */
export type Hash64 = readonly [hi: number, lo: number];

const HEX16 = /^[0-9a-f]{16}$/;

/**
 * The hash as 16 lowercase hex digits, or null when `v` is not one.
 *
 * Case and surrounding whitespace are forgiven, because the type declares both fields
 * case-insensitive and a value pasted from another tool often arrives in capitals. Nothing else is:
 * a `0x` prefix, a 15-digit value that lost a leading zero, or an MD5 (32 digits) is a different
 * value, and guessing what it meant would compare something the caller never had.
 */
export function normHash64(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return HEX16.test(s) ? s : null;
}

/** `v` parsed for distanceOf, or null when it is not 16 hex digits. */
export function parseHash64(v: unknown): Hash64 | null {
    const s = normHash64(v);
    if (s === null) return null;
    return [parseInt(s.slice(0, 8), 16), parseInt(s.slice(8), 16)];
}

const popcount32 = (x: number): number => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

/** Bits that differ between two parsed hashes, 0 to 64. */
export const distanceOf = (a: Hash64, b: Hash64): number => popcount32(a[0] ^ b[0]) + popcount32(a[1] ^ b[1]);

/** Bits that differ between two hashes, or null when either is not 16 hex digits. */
export function hashDistance(a: unknown, b: unknown): number | null {
    const x = parseHash64(a);
    const y = parseHash64(b);
    return x && y ? distanceOf(x, y) : null;
}

/**
 * Whether `h` is what a flat image hashes to: a blank, transparent or single-colour icon.
 *
 * Measured on Web Recon's implementation (the one that writes these fields): every flat image, at
 * 16, 32, 48 and 64 pixels and at any gray level, has dHash 0000000000000000 and pHash
 * 8000000000000000 (0000000000000000 when it is black). Pillow and ImageHash give the same pair for
 * a one-colour PNG (Web Recon's test-fixtures/favicons/expected.json). A flat image has no gradient
 * for a dHash to record and no frequencies but the mean for a pHash, so the value says nothing
 * about the picture: every blank favicon is 0 bits from every other one, whatever its colour.
 * Comparing it would link unrelated sites on the commonest favicon there is.
 */
export function isFlatImageHash(h: Hash64 | string): boolean {
    const p = typeof h === 'string' ? parseHash64(h) : h;
    return !!p && (p[0] === 0 || p[0] === 0x80000000) && p[1] === 0;
}

/**
 * How near a flat image's hash a value may lie and still be skipped like one: within this many
 * bits of 0000000000000000 or 8000000000000000, it says too little about the picture to compare.
 *
 * The exact flat values were not enough. ImageHash's pHash sets exactly 32 bits unless coefficients
 * tie at the median, so an ordinary icon's pHash lies 31 bits from 8000000000000000: 30 of 32 public
 * sites' favicons did, hashed with Web Recon's code. A symmetric picture zeroes its odd-frequency
 * coefficients, they tie at the median, and most bits stay clear. On 200 random logos of 2 to 5
 * discs and boxes (white on black, 32 px), one mirrored left to right lay 3 to 19 bits from the flat
 * value (median 15), and one centred both ways 0 to 10 (the other two public favicons: a block-letter
 * logo at 8 and a near-blank one at 3). Values that close crowd together whatever the logo is:
 * unrelated mirrored logos were within 10 bits of each other on phash or dhash in 14% of pairs, and
 * a disc, ring, plus, square and diamond were 1 to 10 bits apart on phash while 14 to 32 apart on
 * dhash. Nor do they survive a re-encode: noise of ±3 gray levels moved the block-letter logo's
 * pHash 23 bits. Skipping values within 16 bits brought the mirrored pairs from 14% to 0.55%.
 *
 * A dHash meets the same line from below: few bits set is a picture with few horizontal edges, and
 * two dots in opposite corners (5 and 4 bits set) were 9 bits apart. The public favicons' dHashes
 * lay 20 to 37 bits from 0, apart from the block-letter logo at 16 and the near-blank one at 0, so
 * the line costs an ordinary icon nothing; when one of a favicon's hashes is skipped the other is
 * still compared.
 */
export const LOW_INFORMATION_BITS = 16;

/** Bits between `h` and the nearer flat value (see isFlatImageHash). */
const bitsFromFlat = (h: Hash64): number =>
    Math.min(popcount32(h[0]) + popcount32(h[1]), popcount32(h[0] ^ 0x80000000) + popcount32(h[1]));

/**
 * Whether `h` is a flat image's hash or lies within LOW_INFORMATION_BITS of one: a blank,
 * single-colour, symmetric or nearly empty icon, whose closeness to another value says nothing.
 */
export function isLowInformationHash(h: Hash64 | string): boolean {
    const p = typeof h === 'string' ? parseHash64(h) : h;
    return !!p && bitsFromFlat(p) <= LOW_INFORMATION_BITS;
}

/** A node to compare, with the values of the fields being compared (others may be left out). */
export interface HashCandidate {
    id: string;
    values: Readonly<Record<string, unknown>>;
}

/** A candidate within reach of the reference: its closest field, and every field compared. */
export interface HashMatch {
    id: string;
    field: string;
    distance: number;
    distances: Record<string, number>;
}

export interface HashRanking {
    /** Within `maxBits`, closest first; ties keep the candidates' order. */
    matches: HashMatch[];
    /** Candidates that had at least one comparable value. */
    compared: number;
    /** Values present but not 16 hex digits. */
    skippedInvalid: number;
    /** Values too near a flat image's hash to say anything (isLowInformationHash), never compared. */
    skippedUninformative: number;
}

/**
 * Compare every candidate with the reference, field by field: a candidate's `phash` against the
 * reference's `phash`, never against its `dhash`, because two algorithms' values of one picture are
 * no closer than two random numbers. A candidate counts as a match when ANY field is within
 * `maxBits`, and is reported by its closest field.
 *
 * Any, not every: a small edit moves the two hashes very differently. On 32 public favicons,
 * inverting a square a tenth of the icon's width in one corner moved the pHash more than 10 bits in
 * 25 of them and the dHash at most 3 bits in all, so requiring both would lose the touched-up copy
 * of a kit's icon, the case these hashes are kept for. What makes a one-hash match meaningless is a
 * value too near a flat one, and isLowInformationHash drops those.
 *
 * A missing or empty value is not counted anywhere: most nodes have no perceptual hash at all, and
 * reporting them as skipped would bury the values that really were malformed.
 */
export function rankByHashDistance(
    reference: Readonly<Record<string, Hash64>>,
    candidates: Iterable<HashCandidate>,
    maxBits: number,
): HashRanking {
    // A flat or near-flat reference would match every blank or symmetric icon; it is no reference.
    const fields = Object.keys(reference).filter((f) => !isLowInformationHash(reference[f]));
    const matches: HashMatch[] = [];
    let compared = 0;
    let skippedInvalid = 0;
    let skippedUninformative = 0;
    for (const c of candidates) {
        const distances: Record<string, number> = {};
        let best: { field: string; distance: number } | null = null;
        for (const field of fields) {
            const raw = c.values[field];
            if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) continue;
            const h = parseHash64(raw);
            if (!h) {
                skippedInvalid++;
                continue;
            }
            if (isLowInformationHash(h)) {
                skippedUninformative++;
                continue;
            }
            const d = distanceOf(reference[field], h);
            distances[field] = d;
            if (!best || d < best.distance) best = { field, distance: d };
        }
        if (!best) continue;
        compared++;
        if (best.distance <= maxBits) matches.push({ id: c.id, ...best, distances });
    }
    // Array.prototype.sort is stable, so equal distances stay in the order the caller listed them.
    matches.sort((a, b) => a.distance - b.distance);
    return { matches, compared, skippedInvalid, skippedUninformative };
}

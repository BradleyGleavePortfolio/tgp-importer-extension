// Platform dispatcher. Given a tab URL, decide which extractor (if any) can
// drive it. Matching is on the hostname SUFFIX so Tier-1 cosmetic white-label
// brand subdomains (e.g. theirbrand.truecoach.co) resolve to the same
// extractor as the flagship host — zero per-brand effort (see docs/DESIGN.md
// §5, Tier 1).
//
// R75: zero banned type-assertions. URL parsing is guarded; a malformed URL
// yields null rather than throwing.

// Suffix -> platform id. A hostname matches when it equals the suffix or ends
// with "." + suffix (so both "truecoach.co" and "brand.truecoach.co" match).
/** @type {{suffix: string, platform: "truecoach"}[]} */
const HOST_SUFFIXES = [
    { suffix: "truecoach.co", platform: "truecoach" },
    // Additional platforms are stubbed below (return null) until their
    // extractors land in v0.3+. Host patterns are documented in
    // docs/ROADMAP.md but are NOT wired here so detectPlatform never claims a
    // platform we cannot actually extract.
];

function hostnameOf(url) {
    if (typeof url !== "string" || url.length === 0) {
        return null;
    }
    try {
        return new URL(url).hostname.toLowerCase();
    }
    catch {
        return null;
    }
}

function matchesSuffix(hostname, suffix) {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Resolve a tab URL to a supported platform id, or null when unsupported.
 * @param {string} url active-tab URL.
 * @returns {"truecoach"|null} platform id.
 */
export function detectPlatform(url) {
    const hostname = hostnameOf(url);
    if (hostname === null) {
        return null;
    }
    for (const entry of HOST_SUFFIXES) {
        if (matchesSuffix(hostname, entry.suffix)) {
            return entry.platform;
        }
    }
    // v0.3: coachrx | mypthub | trainerize | ptdistinction | fitsw |
    //       trainheroic | everfit | teambuildr | kabata — each returns null
    //       until its extractor + verified API base exist (docs/ROADMAP.md).
    return null;
}

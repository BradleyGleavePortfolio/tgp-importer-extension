// Deterministic URL-path evidence only. Query values and candidate identifiers
// never enter the result.

const SUPPORTED_QUERY_KEYS = new Set([
    "after", "before", "cursor", "end", "from", "limit", "offset", "page",
    "per_page", "since", "start", "to", "until",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const SHORT_ID = /^(?=[A-Z0-9]{6,16}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+$/;
const PII_SEGMENT = /@|%40|^(?:<redacted>|\[redacted\])$/i;

function candidateKind(segment) {
    if (UUID.test(segment)) return "uuid";
    if (INTEGER.test(segment)) return "integer";
    if (SHORT_ID.test(segment)) return "short";
    return null;
}

function splitPath(path, maxSegments) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
        /[\\\x00-\x1f\x7f?#]/.test(path)) return null;
    const segments = path.split("/").slice(1);
    let decoded;
    try {
        decoded = segments.map((part) => decodeURIComponent(part));
    }
    catch {
        return null;
    }
    if (segments.length > maxSegments || segments.some((part) => part.length > 256) ||
        decoded.some((part) => PII_SEGMENT.test(part))) {
        return null;
    }
    return segments;
}

function supportedQueryKeys(value) {
    if (!Array.isArray(value) || value.length > 64) return [];
    return [...new Set(value.filter((key) => typeof key === "string" &&
        SUPPORTED_QUERY_KEYS.has(key.toLowerCase())).map((key) => key.toLowerCase()))].sort();
}

function templateFrom(segments, dynamic) {
    return "/" + segments.map((segment, index) => dynamic.has(index) ? ":id" : segment).join("/");
}

function groupBy(values, keyFor) {
    const groups = new Map();
    for (const value of values) {
        const key = keyFor(value);
        const group = groups.get(key) ?? [];
        group.push(value);
        groups.set(key, group);
    }
    return groups;
}

function isSafeOrigin(raw) {
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase().replace(/\.+$/, "");
        return url.protocol === "https:" && url.username === "" && url.password === "" &&
            url.origin === raw && host !== "localhost" && !host.endsWith(".localhost") &&
            !host.startsWith("[") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    }
    catch {
        return false;
    }
}

export function inferUrlTemplates(observations, options) {
    const minDistinct = Number.isInteger(options?.minDistinct) && options.minDistinct >= 2
        ? options.minDistinct
        : 3;
    const maxObservations = Number.isInteger(options?.maxObservations) && options.maxObservations > 0
        ? options.maxObservations
        : 1000;
    const maxSegments = Number.isInteger(options?.maxSegments) && options.maxSegments > 0
        ? options.maxSegments
        : 32;
    const rejected = new Map();
    const rows = [];
    const input = Array.isArray(observations) ? observations : [];
    if (!Array.isArray(observations)) rejected.set("invalid_observations", 1);
    if (input.length > maxObservations) rejected.set("observation_limit", input.length - maxObservations);
    for (const observation of input.slice(0, maxObservations)) {
        const segments = splitPath(observation?.path, maxSegments);
        if (typeof observation?.origin !== "string" || !isSafeOrigin(observation.origin) ||
            !["GET", "HEAD"].includes(observation?.method) || segments === null) {
            rejected.set("invalid_observation", (rejected.get("invalid_observation") ?? 0) + 1);
            continue;
        }
        const kinds = segments.map(candidateKind);
        const skeleton = segments.map((segment, index) => kinds[index] ?? `=${segment}`);
        rows.push({
            origin: observation.origin,
            method: observation.method,
            queryKeys: observation.queryKeys,
            segments,
            kinds,
            skeleton: JSON.stringify(skeleton),
        });
    }

    const coarse = groupBy(rows, (row) => `${row.origin}\n${row.method}\n${row.skeleton}`);
    const clusters = [];
    for (const group of coarse.values()) {
        const candidateIndexes = group[0].kinds.flatMap((kind, index) => kind === null ? [] : [index]);
        const dynamic = new Set(candidateIndexes.filter((index) =>
            new Set(group.map((row) => row.segments[index])).size >= minDistinct));
        const partitions = groupBy(group, (row) => JSON.stringify(
            candidateIndexes.filter((index) => !dynamic.has(index)).map((index) => row.segments[index]),
        ));
        for (const partition of partitions.values()) {
            const queryKeys = [...new Set(partition.flatMap((row) => supportedQueryKeys(row.queryKeys)))].sort();
            clusters.push({
                origin: partition[0].origin,
                method: partition[0].method,
                template: templateFrom(partition[0].segments, dynamic),
                queryKeys,
                observations: partition.length,
            });
        }
    }
    clusters.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
        clusters,
        excluded: [...rejected].sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, count]) => ({ reason, count })),
    };
}

export { candidateKind, SUPPORTED_QUERY_KEYS };

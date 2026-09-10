import { compareText } from "./order.js";
const SUPPORTED_QUERY_KEYS = new Set(["after", "before", "cursor", "end", "from", "limit", "offset", "page",
    "per_page", "since", "start", "to", "until"]);
const UUID_SHAPE = /^[a-f0-9]{8}-[a-f0-9]{4}-([0-9a-f])[a-f0-9]{3}-([0-9a-f])[a-f0-9]{3}-[a-f0-9]{12}$/i,
    INTEGER = /^(?:0|[1-9]\d*)$/, OPAQUE = /^(?=.{6,64}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+$/, VERSION = /^v\d{1,3}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/, YEAR = /^\d{4}$/, YEAR_MONTH = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/,
    DECIMAL = /^(?:0|[1-9]\d*)\.\d+$/;
const HARD = Object.freeze({ minDistinct: 32, maxObservations: 1000, maxSegments: 32 }), MAX_PATH_CHARS = 1024 * 1024;
function candidateKind(segment) { const match = typeof segment === "string" ? segment.match(UUID_SHAPE) : null;
    if (match) return /[1-8]/i.test(match[1]) && /[89ab]/i.test(match[2]) ? "uuid" : null;
    if (typeof segment !== "string" || /^[a-f0-9-]{32,40}$/i.test(segment)) return null;
    if (INTEGER.test(segment) && !YEAR.test(segment)) return "integer";
    return !YEAR_MONTH.test(segment) && OPAQUE.test(segment) ? "opaque" : null; }
function option(options, key, fallback, minimum = 1) { const raw = options?.[key];
    return Number.isInteger(raw) && raw >= minimum ? Math.min(raw, HARD[key]) : fallback; }
function splitPath(path, maxSegments) { if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") ||
        path.startsWith("//") || /[\\\x00-\x1f\x7f?#]/.test(path)) return null;
    const encoded = path.split("/").slice(1); if (encoded.length > maxSegments || encoded.some((part) => part.length > 256)) return null;
    try { const decoded = encoded.map((part) => decodeURIComponent(part).normalize("NFC"));
        return decoded.some((part) => part.length > 256 || /@|^(?:<redacted>|\[redacted\])$/i.test(part)) ? null : decoded;
    } catch { return null; } }
function safeOrigin(raw) { try { const url = new URL(raw);
        const host = url.hostname.toLowerCase().replace(/\.+$/, "");
        return url.protocol === "https:" && !url.username && !url.password && url.origin === raw &&
            host !== "localhost" && !host.endsWith(".localhost") && !host.startsWith("[") &&
            !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    } catch { return false; } }
function structural(segment) { if (VERSION.test(segment)) return `=${segment.toLowerCase()}`;
    if (DATE.test(segment)) return "{date}";
    if (DECIMAL.test(segment)) return "{decimal}";
    return candidateKind(segment) === null ? "{text}" : "{candidate}"; }
function literal(segment) { return encodeURIComponent(segment).replace(/[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function supportedKeys(value) { if (!Array.isArray(value) || value.length > 64) return [];
    return [...new Set(value.filter((key) => typeof key === "string" &&
        SUPPORTED_QUERY_KEYS.has(key.toLowerCase())).map((key) => key.toLowerCase()))].sort(compareText); }
function grouped(values, keyFor) { const out = new Map();
    for (const value of values) { const key = keyFor(value), group = out.get(key) ?? [];
        group.push(value); out.set(key, group); }
    return out; }
export function inferUrlTemplates(observations, options) {
    if (!Array.isArray(observations)) return { clusters: [], excluded: [{ reason: "invalid_observations", count: 1 }] };
    if (observations.length > HARD.maxObservations) return { clusters: [], excluded: [{ reason: "observation_limit", count: observations.length }] };
    if (observations.reduce((n, item) => n + (typeof item?.path === "string" ? item.path.length : 0), 0) >
        MAX_PATH_CHARS) return { clusters: [], excluded: [{ reason: "path_byte_limit", count: observations.length }] };
    const minDistinct = option(options, "minDistinct", 3, 2), maxObservations = option(options, "maxObservations", 1000),
        maxSegments = option(options, "maxSegments", 32), rejected = new Map(), rows = [];
    for (const observation of observations) {
        const segments = splitPath(observation?.path, maxSegments); if (typeof observation?.origin !== "string" || !safeOrigin(observation.origin) ||
            !["GET", "HEAD"].includes(observation?.method) || segments === null) {
            rejected.set("invalid_observation", (rejected.get("invalid_observation") ?? 0) + 1);
        } else rows.push({ origin: observation.origin, method: observation.method, segments,
            queryKeys: supportedKeys(observation.queryKeys) });
    }
    rows.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))); if (rows.length > maxObservations)
        rejected.set("observation_limit", rows.length - maxObservations), rows.length = maxObservations;
    const coarse = grouped(rows, (row) => JSON.stringify([row.origin, row.method, row.segments.map(structural)])), clusters = [];
    for (const group of coarse.values()) {
        const dynamicFor = (partition) => new Set(partition[0].segments.flatMap((_segment, index) => {
            const values = [...new Set(partition.map((row) => row.segments[index]))];
            const months = index > 0 && group.every((row) => YEAR.test(row.segments[index - 1])) &&
                values.every((value) => INTEGER.test(value) && Number(value) >= 1 && Number(value) <= 12);
            return values.length >= minDistinct && !months && values.every((value) => candidateKind(value)) ? [index] : [];
        }));
        let partitions = [group], count; do { count = partitions.length; partitions = partitions.flatMap((partition) => { const dynamic = dynamicFor(partition); return [...grouped(partition, (row) => JSON.stringify(row.segments.filter((_segment, index) => !dynamic.has(index)))).values()]; }); } while (partitions.length > count);
        for (const partition of partitions) { const dynamic = dynamicFor(partition), dynamicSegments = dynamic.size, cluster = {
                origin: partition[0].origin, method: partition[0].method,
                pathPattern: "/" + partition[0].segments.map((segment, index) =>
                    dynamic.has(index) ? ":id" : literal(segment)).join("/"),
                dynamicSegments, replayCompatible: dynamicSegments <= 1,
                queryKeys: [...new Set(partition.flatMap((row) => row.queryKeys))].sort(compareText),
                observations: partition.length,
            };
            if (!cluster.replayCompatible) cluster.reason = "multiple_dynamic_segments"; clusters.push(cluster);
        }
    }
    clusters.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b))); return { clusters, excluded: [...rejected].sort(([a], [b]) => compareText(a, b))
        .map(([reason, count]) => ({ reason, count })) };
}
export { candidateKind, SUPPORTED_QUERY_KEYS, HARD as URL_HARD_LIMITS };

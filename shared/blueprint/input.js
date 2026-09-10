// Pure fail-closed boundary from untrusted capture entries to bounded evidence.
import { isCredentialKey, redactCredentialText } from "../credential-policy.js";
import { compareText } from "./order.js";
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 1000, maxTotalBytes: 8 * 1024 * 1024,
    maxBodyBytes: 1024 * 1024, maxDepth: 8, maxNodes: 20000, maxArrayLength: 5000,
    maxObjectKeys: 500, maxStringLength: 100000, maxHeaders: 64 });
const HARD_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, maxDepth: 16 });
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const REDACTION = /^(?:<redacted>|\[redacted\])$/i;
const PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/;
const encoder = new TextEncoder();
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function limitsFrom(options) {
    const out = { ...DEFAULT_LIMITS };
    if (isRecord(options)) for (const key of Object.keys(out))
        if (Number.isInteger(options[key]) && options[key] > 0)
            out[key] = Math.min(options[key], HARD_LIMITS[key]);
    return out;
}
function reject(reason) { const error = new Error(reason); error.code = reason; throw error; }
function addBytes(value, state, limit) {
    if (typeof value !== "string") return;
    const remaining = limit - state.bytes;
    if (value.length > remaining) reject("snapshot_byte_limit");
    state.bytes += encoder.encode(value).length;
    if (state.bytes > limit) reject("snapshot_byte_limit");
}
function accountEntry(entry, limits, state) {
    if (!isRecord(entry)) return;
    if (typeof entry.responseBody === "string" && entry.responseBody.length <= limits.maxBodyBytes)
        addBytes(entry.responseBody, state, limits.maxTotalBytes);
    for (const key of ["url", "method", "capturedAt"]) addBytes(entry[key], state, limits.maxTotalBytes);
    if (isRecord(entry.requestHeaders)) for (const [key, value] of Object.entries(entry.requestHeaders)) {
        addBytes(key, state, limits.maxTotalBytes); addBytes(value, state, limits.maxTotalBytes);
    }
}
function boundedClone(value, limits, state, depth = 0) {
    if (++state.nodes > limits.maxNodes) reject("body_node_limit");
    if (depth > limits.maxDepth) reject("body_depth_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : reject("body_non_json_value");
    if (typeof value === "string") {
        if (value.length > limits.maxStringLength) reject("body_string_limit");
        if (redactCredentialText(value) !== value) reject("unredacted_sensitive_value");
        return value;
    }
    if (Array.isArray(value)) return value.length > limits.maxArrayLength
        ? reject("body_collection_limit")
        : value.map((item) => boundedClone(item, limits, state, depth + 1));
    if (!isRecord(value)) reject("body_non_json_value");
    const keys = Object.keys(value).sort(compareText);
    if (keys.length > limits.maxObjectKeys) reject("body_collection_limit");
    const out = Object.create(null);
    for (const key of keys) {
        if (PROTOTYPE_KEY.test(key)) reject("prototype_key");
        const child = value[key];
        if (isCredentialKey(key)) {
            if (typeof child !== "string" || !REDACTION.test(child)) reject("unredacted_sensitive_field");
            out[key] = "[REDACTED]";
        } else out[key] = boundedClone(child, limits, state, depth + 1);
    }
    return out;
}
function normalizeHeaders(raw, limits) {
    if (!isRecord(raw)) return {};
    const names = Object.keys(raw).sort((a, b) => compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b));
    if (names.length > limits.maxHeaders) reject("header_limit");
    const out = Object.create(null);
    for (const name of names) {
        const value = raw[name];
        if (PROTOTYPE_KEY.test(name) || name.length === 0 || name.length > 128 ||
            /[\x00-\x20\x7f()<>@,;:\\"/[\]?={}]/.test(name) || typeof value !== "string" ||
            value.length > 4096 || /[\r\n\x00]/.test(value)) reject("invalid_header");
        const normalized = name.toLowerCase();
        if (Object.hasOwn(out, normalized)) reject("duplicate_header");
        if ((isCredentialKey(name) && !REDACTION.test(value)) ||
            redactCredentialText(value) !== value) reject("unredacted_sensitive_header");
        out[normalized] = "[REDACTED]";
    }
    return out;
}
function normalizeEntry(entry, limits) {
    if (!isRecord(entry)) reject("invalid_entry");
    if (typeof entry.url !== "string" || entry.url.length === 0 || entry.url.length > 4096) reject("invalid_url");
    let url; try { url = new URL(entry.url); } catch { reject("invalid_url"); }
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (url.protocol !== "https:" || url.username || url.password || !host || host === "localhost" ||
        host.endsWith(".localhost") || host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) reject("unsafe_url");
    const method = typeof entry.method === "string" ? entry.method.toUpperCase() : "";
    if (!SAFE_METHODS.has(method)) reject("unsupported_method");
    if (typeof entry.responseBody !== "string") reject("invalid_body");
    if (entry.responseBody.length > limits.maxBodyBytes ||
        encoder.encode(entry.responseBody).length > limits.maxBodyBytes) reject("body_byte_limit");
    let parsed; try { parsed = JSON.parse(entry.responseBody); } catch { reject("malformed_json"); }
    let status = null;
    if (Object.hasOwn(entry, "statusCode")) {
        if (!Number.isInteger(entry.statusCode) || entry.statusCode < 100 || entry.statusCode > 599) reject("invalid_status");
        status = entry.statusCode;
    }
    let capturedAt = null;
    if (Object.hasOwn(entry, "capturedAt")) {
        if (typeof entry.capturedAt !== "string" || entry.capturedAt.length > 64 ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.capturedAt) ||
            new Date(entry.capturedAt).toISOString() !== entry.capturedAt) reject("invalid_timestamp");
        capturedAt = entry.capturedAt;
    }
    return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort(compareText),
        method, status, capturedAt, headers: normalizeHeaders(entry.requestHeaders, limits),
        body: boundedClone(parsed, limits, { nodes: 0 }) };
}
function stableKey(value) { return JSON.stringify(value, (_key, child) => isRecord(child)
    ? Object.fromEntries(Object.keys(child).sort(compareText).map((key) => [key, child[key]])) : child); }
export function normalizeCaptureSnapshot(snapshot, options) {
    const limits = limitsFrom(options);
    if (!Array.isArray(snapshot))
        return { observations: [], excluded: [{ reason: "invalid_snapshot", count: 1 }] };
    if (snapshot.length > HARD_LIMITS.maxEntries)
        return { observations: [], excluded: [{ reason: "entry_limit", count: snapshot.length }] };
    try {
        const state = { bytes: 0 };
        for (const entry of snapshot) accountEntry(entry, limits, state);
    } catch (error) { if (error?.code !== "snapshot_byte_limit") throw error;
        return { observations: [], excluded: [{ reason: "snapshot_byte_limit", count: snapshot.length }] }; }
    const rejected = new Map();
    const observations = [];
    for (const entry of snapshot) try { observations.push(normalizeEntry(entry, limits)); }
    catch (error) {
        const reason = typeof error?.code === "string" ? error.code : "invalid_entry";
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    }
    observations.sort((a, b) => compareText(stableKey(a), stableKey(b)));
    if (observations.length > limits.maxEntries)
        rejected.set("entry_limit", observations.length - limits.maxEntries),
        observations.length = limits.maxEntries;
    return { observations, excluded: [...rejected].sort(([a], [b]) => compareText(a, b))
        .map(([reason, count]) => ({ reason, count })) };
}
export { DEFAULT_LIMITS, HARD_LIMITS };

// Pure boundary from untrusted, permanently-redacted capture entries to bounded
// inference observations. Rejections are counted by stable reason rather than
// retaining attacker-controlled input.

const DEFAULT_LIMITS = Object.freeze({
    maxEntries: 1000,
    maxBodyBytes: 1024 * 1024,
    maxDepth: 8,
    maxNodes: 20000,
    maxArrayLength: 5000,
    maxObjectKeys: 500,
    maxStringLength: 100000,
    maxHeaders: 64,
});

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SENSITIVE_KEY = /^(access_token|refresh_token|id_token|token|api[-_]?key|authorization|cookie|set-cookie|password|secret|session)$/i;
const REDACTION = /^(?:<redacted>|\[redacted\])$/i;
const PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/;

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitsFrom(options) {
    const out = { ...DEFAULT_LIMITS };
    if (!isRecord(options)) return out;
    for (const key of Object.keys(out)) {
        if (Number.isInteger(options[key]) && options[key] > 0) out[key] = options[key];
    }
    return out;
}

function reject(reason) {
    const error = new Error(reason);
    error.code = reason;
    throw error;
}

function boundedClone(value, limits, state, depth = 0) {
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) reject("body_node_limit");
    if (depth > limits.maxDepth) reject("body_depth_limit");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) reject("body_non_json_value");
        return value;
    }
    if (typeof value === "string") {
        if (value.length > limits.maxStringLength) reject("body_string_limit");
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > limits.maxArrayLength) reject("body_collection_limit");
        return value.map((item) => boundedClone(item, limits, state, depth + 1));
    }
    if (!isRecord(value)) reject("body_non_json_value");
    const keys = Object.keys(value).sort();
    if (keys.length > limits.maxObjectKeys) reject("body_collection_limit");
    const out = Object.create(null);
    for (const key of keys) {
        if (PROTOTYPE_KEY.test(key)) reject("prototype_key");
        const child = value[key];
        if (SENSITIVE_KEY.test(key)) {
            if (typeof child !== "string" || !REDACTION.test(child)) {
                reject("unredacted_sensitive_field");
            }
            out[key] = "[REDACTED]";
        }
        else {
            out[key] = boundedClone(child, limits, state, depth + 1);
        }
    }
    return out;
}

function normalizeHeaders(raw, limits) {
    if (!isRecord(raw)) return {};
    const names = Object.keys(raw).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (names.length > limits.maxHeaders) reject("header_limit");
    const out = Object.create(null);
    for (const name of names) {
        const value = raw[name];
        if (PROTOTYPE_KEY.test(name) || name.length === 0 || name.length > 128 ||
            /[\x00-\x20\x7f()<>@,;:\\"/[\]?={}]/.test(name)) {
            reject("invalid_header");
        }
        if (typeof value !== "string" || value.length > 4096 || /[\r\n\x00]/.test(value)) {
            reject("invalid_header");
        }
        if (SENSITIVE_KEY.test(name)) {
            if (!REDACTION.test(value)) reject("unredacted_sensitive_header");
            out[name.toLowerCase()] = "[REDACTED]";
        }
        else {
            out[name.toLowerCase()] = value;
        }
    }
    return out;
}

function normalizeEntry(entry, limits) {
    if (!isRecord(entry)) reject("invalid_entry");
    if (typeof entry.url !== "string" || entry.url.length === 0 || entry.url.length > 4096) {
        reject("invalid_url");
    }
    let url;
    try {
        url = new URL(entry.url);
    }
    catch {
        reject("invalid_url");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") {
        reject("unsafe_url");
    }
    const method = typeof entry.method === "string" ? entry.method.toUpperCase() : "";
    if (!SAFE_METHODS.has(method)) reject("unsupported_method");
    if (typeof entry.responseBody !== "string") reject("invalid_body");
    if (new TextEncoder().encode(entry.responseBody).length > limits.maxBodyBytes) {
        reject("body_byte_limit");
    }
    let parsed;
    try {
        parsed = JSON.parse(entry.responseBody);
    }
    catch {
        reject("malformed_json");
    }
    const body = boundedClone(parsed, limits, { nodes: 0 });
    const status = Number.isInteger(entry.statusCode) && entry.statusCode >= 100 &&
        entry.statusCode <= 599 ? entry.statusCode : null;
    const capturedAt = typeof entry.capturedAt === "string" && entry.capturedAt.length <= 64
        ? entry.capturedAt
        : null;
    return {
        origin: url.origin,
        path: url.pathname,
        queryKeys: [...new Set(url.searchParams.keys())].sort(),
        method,
        status,
        capturedAt,
        headers: normalizeHeaders(entry.requestHeaders, limits),
        body,
    };
}

function stableObservationKey(value) {
    return JSON.stringify(value, (_key, child) => {
        if (!isRecord(child)) return child;
        return Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]));
    });
}

export function normalizeCaptureSnapshot(snapshot, options) {
    const limits = limitsFrom(options);
    const rejected = new Map();
    const observations = [];
    const entries = Array.isArray(snapshot) ? snapshot : [];
    if (!Array.isArray(snapshot)) rejected.set("invalid_snapshot", 1);
    if (entries.length > limits.maxEntries) rejected.set("entry_limit", entries.length - limits.maxEntries);
    for (const entry of entries.slice(0, limits.maxEntries)) {
        try {
            observations.push(normalizeEntry(entry, limits));
        }
        catch (error) {
            const reason = typeof error?.code === "string" ? error.code : "invalid_entry";
            rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
        }
    }
    observations.sort((a, b) => stableObservationKey(a).localeCompare(stableObservationKey(b)));
    return {
        observations,
        excluded: [...rejected].sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, count]) => ({ reason, count })),
    };
}

export { DEFAULT_LIMITS };

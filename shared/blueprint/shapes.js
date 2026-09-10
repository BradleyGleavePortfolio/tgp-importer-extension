import { compareText } from "./order.js";
const DEFAULTS = Object.freeze({ maxDepth: 3, maxCollection: 100, maxVariants: 16, maxNodes: 5000, maxObservations: 1000 }),
    HARD = Object.freeze({ maxDepth: 16, maxCollection: 200, maxVariants: 32, maxNodes: 20000, maxObservations: 1000 });
function kindOf(value) { if (value === null) return "null"; if (Array.isArray(value)) return "array";
    const type = typeof value;
    return type === "object" || type === "string" || type === "boolean" || (type === "number" && Number.isFinite(value)) ? type : "unsupported";
}
function limit(options, key) { const raw = options?.[key];
    return Number.isInteger(raw) && raw >= (key === "maxDepth" ? 0 : 1) ? Math.min(raw, HARD[key]) : DEFAULTS[key];
}
function keyToken(key) {
    if (/^[a-z]{1,32}$/.test(key) && key !== "constructor") return key;
    let hash = 0xcbf29ce484222325n; for (const char of key)
        hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
    return `#${hash.toString(16).padStart(16, "0")}`;
}
export function shapeSignature(value, options) {
    const maxDepth = limit(options, "maxDepth"), maxCollection = limit(options, "maxCollection");
    const maxVariants = limit(options, "maxVariants"), maxNodes = limit(options, "maxNodes"), active = new WeakSet(); let nodes = 0;
    function visit(node, depth) {
        if (++nodes > maxNodes) throw new Error("shape_work_limit");
        const kind = kindOf(node);
        if (kind !== "array" && kind !== "object") return kind;
        if (depth >= maxDepth) return `${kind}(*)`;
        if (active.has(node)) return `${kind}(cycle)`;
        active.add(node); let result;
        if (Array.isArray(node)) {
            if (node.length > maxCollection) result = "array(overflow)";
            else { const variants = [...new Set(node.map((item) => visit(item, depth + 1)))].sort(compareText);
                const kept = variants.slice(0, maxVariants);
                if (variants.length > maxVariants) kept.push("...");
                result = `array[${kept.join("|")}]`;
            }
        } else {
            const keys = Object.keys(node); if (keys.length > maxCollection) result = "object(overflow)";
            else { const fields = keys.map((key) => [keyToken(key), key]).sort(([a, x], [b, y]) => compareText(a, b) || compareText(x, y));
                result = `object{${fields.map(([token, key]) => `${token}:${visit(node[key], depth + 1)}`).join(",")}}`;
            }
        }
        active.delete(node); return result;
    }
    try { return visit(value, 0); } catch (error) {
        if (error instanceof Error && error.message === "shape_work_limit") return "work(overflow)";
        throw error;
    }
}
export function clusterResponseShapes(observations, options) {
    if (!Array.isArray(observations) || observations.length > HARD.maxObservations) return [];
    const rows = observations.map((observation) => ({ origin: typeof observation?.origin === "string" ? observation.origin : null,
        method: ["GET", "HEAD"].includes(observation?.method) ? observation.method : null,
        signature: shapeSignature(observation?.body, options) }))
        .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
    rows.length = Math.min(rows.length, limit(options, "maxObservations"));
    const counts = new Map(); for (const row of rows) { const key = JSON.stringify(row);
        counts.set(key, (counts.get(key) ?? 0) + 1); }
    return [...counts].sort(([a], [b]) => compareText(a, b))
        .map(([key, count]) => ({ ...JSON.parse(key), observations: count }));
}
export { DEFAULTS as SHAPE_DEFAULT_LIMITS, HARD as SHAPE_HARD_LIMITS };

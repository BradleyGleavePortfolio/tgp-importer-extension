// PII-free structural signatures. Values are represented only by JSON type;
// object traversal is sorted and all depth/collection work is bounded.

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/;

function kindOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return "object";
    if (typeof value === "string") return "string";
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    if (typeof value === "boolean") return "boolean";
    return "unsupported";
}

function safeKey(key) {
    return SAFE_KEY.test(key) && !PROTOTYPE_KEY.test(key) ? key : "<key>";
}

export function shapeSignature(value, options) {
    const maxDepth = Number.isInteger(options?.maxDepth) && options.maxDepth >= 0
        ? options.maxDepth
        : 2;
    const maxCollection = Number.isInteger(options?.maxCollection) && options.maxCollection > 0
        ? options.maxCollection
        : 100;
    const maxVariants = Number.isInteger(options?.maxVariants) && options.maxVariants > 0
        ? options.maxVariants
        : 16;
    const active = new WeakSet();

    function visit(node, depth) {
        const kind = kindOf(node);
        if (kind !== "array" && kind !== "object") return kind;
        if (depth >= maxDepth) return `${kind}(*)`;
        if (active.has(node)) return `${kind}(cycle)`;
        active.add(node);
        let result;
        if (kind === "array") {
            if (node.length > maxCollection) result = "array(overflow)";
            else {
                const variants = [...new Set(node.map((item) => visit(item, depth + 1)))].sort();
                const kept = variants.slice(0, maxVariants);
                if (variants.length > maxVariants) kept.push("...");
                result = `array[${kept.join("|")}]`;
            }
        }
        else {
            const keys = Object.keys(node).sort();
            if (keys.length > maxCollection) result = "object(overflow)";
            else {
                const fields = keys.map((key) => `${safeKey(key)}:${visit(node[key], depth + 1)}`);
                result = `object{${[...new Set(fields)].sort().join(",")}}`;
            }
        }
        active.delete(node);
        return result;
    }
    return visit(value, 0);
}

export function clusterResponseShapes(observations, options) {
    const maxObservations = Number.isInteger(options?.maxObservations) &&
        options.maxObservations > 0 ? options.maxObservations : 1000;
    const input = Array.isArray(observations) ? observations.slice(0, maxObservations) : [];
    const counts = new Map();
    for (const observation of input) {
        const signature = shapeSignature(observation?.body, options);
        counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b))
        .map(([signature, observations]) => ({ signature, observations }));
}

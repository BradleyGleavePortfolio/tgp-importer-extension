// Structure fingerprint (L0 D-L0-5): sha256 over the sorted set of
// `(method, template, shapeSignature(itemShape, depth 2))` for every digest
// template with role `collection`. The signature re-implements
// shared/blueprint/shapes.js semantics over a digest ShapeNode (kinds only,
// never key names or values), so the backend can compute the same bytes from
// the digest alone. `fingerprintMaterial` is the exact pre-image, one tuple per
// line, and is what the cross-repo vectors pin.
import { compareText } from "../blueprint/order.js";

export const FINGERPRINT_DEPTH = 2;
const encoder = new TextEncoder();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// shapes.js shapeSignature over a ShapeNode: `object{child*count,...}` with
// children sorted, `array[items]`, scalars by kind, and `(*)` past the depth.
export function itemShapeSignature(
  node,
  depth = 0,
  maxDepth = FINGERPRINT_DEPTH,
) {
  if (!isRecord(node) || typeof node.kind !== "string") return "unsupported";
  if (node.kind === "object") {
    if (depth >= maxDepth) return "object(*)";
    const counts = new Map();
    for (const key of Object.keys(isRecord(node.keys) ? node.keys : {})) {
      const child = itemShapeSignature(node.keys[key], depth + 1, maxDepth);
      counts.set(child, (counts.get(child) ?? 0) + 1);
    }
    return `object{${[...counts]
      .sort(([a], [b]) => compareText(a, b))
      .map(([child, count]) => `${child}*${count}`)
      .join(",")}}`;
  }
  if (node.kind === "array") {
    if (depth >= maxDepth) return "array(*)";
    return `array[${itemShapeSignature(node.items, depth + 1, maxDepth)}]`;
  }
  // An object keyed by data: only its value shape is structural.
  if (node.kind === "map") {
    if (depth >= maxDepth) return "map(*)";
    return `map[${itemShapeSignature(node.values, depth + 1, maxDepth)}]`;
  }
  return ["string", "number", "boolean", "null", "mixed"].includes(node.kind)
    ? node.kind
    : "unsupported";
}
function readPath(node, path) {
  let current = node;
  for (const key of path) {
    if (
      !isRecord(current) ||
      current.kind !== "object" ||
      !isRecord(current.keys)
    )
      return null;
    current = current.keys[key];
  }
  return isRecord(current) ? current : null;
}
// The item shape of a collection template: the `items` node of the array at
// its first collection path (`[]` = the body itself is the array).
export function collectionItemShape(template) {
  const path = Array.isArray(template?.collectionPaths)
    ? template.collectionPaths[0]
    : undefined;
  if (!Array.isArray(path)) return null;
  const array = readPath(template.shape, path);
  return array !== null && array.kind === "array" && isRecord(array.items)
    ? array.items
    : null;
}
export function fingerprintMaterial(digest) {
  if (!isRecord(digest) || !Array.isArray(digest.templates))
    throw new Error("invalid_digest");
  const tuples = new Set();
  for (const template of digest.templates) {
    if (!isRecord(template) || template.role !== "collection") continue;
    if (
      typeof template.method !== "string" ||
      typeof template.template !== "string"
    )
      throw new Error("invalid_digest");
    const itemShape = collectionItemShape(template);
    tuples.add(
      JSON.stringify([
        template.method,
        template.template,
        itemShape === null ? "unsupported" : itemShapeSignature(itemShape),
      ]),
    );
  }
  return [...tuples].sort(compareText);
}
function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
// sha256 (lower-case hex) over the newline-joined material, UTF-8.
export async function structureFingerprint(digest) {
  const material = fingerprintMaterial(digest).join("\n");
  return hex(
    await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(material)),
  );
}

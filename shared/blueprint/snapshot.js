// Only own data descriptors carry authority. Never invoke caller accessors,
// iterators or array methods. Proxy descriptor traps may throw; API boundaries
// sanitize them. JavaScript cannot bound time spent inside a hostile trap.
export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function data(value, key, required = false) {
  const descriptor =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, key)
      : undefined;
  if (
    (required && !descriptor) ||
    (descriptor && !Object.hasOwn(descriptor, "value"))
  )
    throw new TypeError("non_data_field");
  return descriptor?.value;
}
export function arrayLength(value) {
  if (!Array.isArray(value)) throw new TypeError("non_array");
  const length = data(value, "length", true);
  if (!Number.isInteger(length) || length < 0)
    throw new TypeError("invalid_length");
  return length;
}
export function indices(value, length, holes = false) {
  const copy = [];
  for (let index = 0; index < length; index++)
    copy.push(data(value, index, !holes));
  return copy;
}
export function observationRows(positions) {
  return positions.map((entry) => {
    if (!record(entry)) return null;
    const origin = data(entry, "origin"),
      method = data(entry, "method"),
      path = data(entry, "path"),
      keys = data(entry, "queryKeys");
    const length = Array.isArray(keys) ? arrayLength(keys) : 65;
    return {
      origin,
      method,
      path,
      queryKeys: length <= 64 ? indices(keys, length, true) : [],
    };
  });
}
export function inferenceOptions(options) {
  return Object.fromEntries(
    ["minDistinct", "maxObservations", "maxSegments", "membership"].map(
      (key) => [key, data(options, key)],
    ),
  );
}
export const URL_TEXT_LIMITS = Object.freeze({
  origin: 4096,
  method: 4,
  pathPattern: 36864,
});

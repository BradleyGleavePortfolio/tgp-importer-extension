// The current backend acknowledges an accepted envelope, not a native migration.
// Bound body bytes as well as time (the caller owns the request deadline).
const MAX_ACK_BYTES = 4096;

export async function readIngestAcknowledgement(response, expected) {
  let reader;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ACK_BYTES) throw new Error("ack_too_large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const ack = JSON.parse(text);
    if (
      ack === null ||
      typeof ack !== "object" ||
      Array.isArray(ack) ||
      !Number.isSafeInteger(ack.received) ||
      ack.received !== expected ||
      !Number.isSafeInteger(ack.deduped) ||
      ack.deduped < 0 ||
      ack.deduped > ack.received
    )
      throw new Error("ack_counts");
    return { received: ack.received, deduped: ack.deduped };
  } catch {
    // Never echo response bytes, parser errors or transport diagnostics.
    if (reader) void reader.cancel().catch(() => undefined);
    throw new Error("ingest_ack_invalid");
  } finally {
    if (reader) reader.releaseLock();
  }
}

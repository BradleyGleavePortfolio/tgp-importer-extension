import { describe, expect, it, vi } from "vitest";
import { readIngestAcknowledgement } from "../shared/ingest-ack.js";

describe("receipt cleanup failure visibility", () => {
  it("rejects the receipt promptly and logs only a fixed code if cancellation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4097));
          },
          cancel() {
            return Promise.reject(new Error("PRIVATE_RESPONSE_BODY"));
          },
        }),
      );
      await expect(readIngestAcknowledgement(response, 1)).rejects.toThrow(
        "ingest_ack_invalid",
      );
      await Promise.resolve();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          src: "tgp-importer",
          event: "ingest_ack_cancel_failed",
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
      expect(response.body.locked).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

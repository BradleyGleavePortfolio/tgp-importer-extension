// Read-only projection of local transfer evidence. No source totals, native
// records, retries, or authority are inferred from a staging acknowledgement.
function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function outcomeView(snapshot, message) {
  const state = snapshot.intent?.status;
  const active = state === "ingest_started" && snapshot.workerActive === true;
  const titleKey = active
    ? "outcome_running"
    : state === "ingest_started"
      ? "outcome_interrupted"
      : state === "ingest_succeeded"
        ? "replay_status_staged"
        : state === "ingest_empty"
          ? "outcome_empty"
          : "outcome_attention";
  const rows = new Map();
  const staging = snapshot.staging;
  if (staging && typeof staging === "object") {
    for (const [family, receipt] of Object.entries(staging)) {
      if (
        receipt &&
        count(receipt.received) &&
        count(receipt.inserted) &&
        count(receipt.deduped) &&
        receipt.inserted + receipt.deduped === receipt.received
      ) {
        rows.set(family, { family, ...receipt, unconfirmed: 0 });
      }
    }
  }
  const pending = snapshot.pendingTransfer;
  if (
    pending &&
    typeof pending.entityType === "string" &&
    count(pending.count) &&
    pending.count > 0
  ) {
    const row = rows.get(pending.entityType) ?? {
      family: pending.entityType,
      received: 0,
      inserted: 0,
      deduped: 0,
    };
    rows.set(pending.entityType, { ...row, unconfirmed: pending.count });
  }
  const lines = [...rows.values()].map((row) => {
    // Unknown family names are not copied from source-controlled metadata.
    const familyKey = [
      "clients",
      "notes",
      "exercises",
      "workouts",
      "plans",
    ].includes(row.family)
      ? `outcome_family_${row.family}`
      : "outcome_family_records";
    return {
      label: message(familyKey),
      receipt: message("outcome_receipt", [
        String(row.received),
        String(row.inserted),
        String(row.deduped),
      ]),
      unconfirmed:
        row.unconfirmed > 0
          ? message(active ? "outcome_pending" : "outcome_unconfirmed", [
              String(row.unconfirmed),
            ])
          : "",
    };
  });
  const guidance = message(
    active ? "outcome_running_guidance" : "outcome_guidance",
  );
  const error =
    typeof snapshot.lastError === "string" ? snapshot.lastError : "";
  const issueKey = error.includes("source sign-in required")
    ? "outcome_source_auth"
    : error.includes("ingest_ack_invalid")
      ? "outcome_receipt_invalid"
      : error.startsWith("complete")
        ? "outcome_settlement_failed"
        : error.includes("skipped")
          ? "outcome_source_incomplete"
          : error
            ? "outcome_interrupted_detail"
            : "";
  const issue = issueKey ? message(issueKey) : "";
  const coverage = message("outcome_coverage");
  const native = message("outcome_native");
  const title = message(titleKey);
  const noReceipt = lines.length === 0 ? message("outcome_no_receipt") : "";
  return {
    title,
    lines,
    guidance,
    coverage,
    native,
    noReceipt,
    issue,
    summary: [
      message("outcome_summary_heading"),
      title,
      ...lines.map(
        (row) =>
          `${row.label}: ${row.receipt}${row.unconfirmed ? `; ${row.unconfirmed}` : ""}`,
      ),
      noReceipt,
      issue,
      coverage,
      native,
      guidance,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

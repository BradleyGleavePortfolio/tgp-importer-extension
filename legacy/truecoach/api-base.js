// Quarantined legacy oracle (NORTH_STAR.md "What this retires"): the ONLY place
// the extension names this vendor's API base. Core (shared/, background.js,
// popup/) never imports this file; it reaches the oracle solely through
// legacy/index.js registrations.
export const TRUECOACH_API_BASE = "https://app.truecoach.co/proxy/api";

# Capture Model — what the coach sees and controls

This note explains the Layer 1 passive capture used by the TGP Importer (see
[`AUTO_DISCOVERY.md`](./AUTO_DISCOVERY.md) §2, §6) in plain terms, so a coach
knows exactly what happens when they start an import.

## Why a debugger banner appears

To read the JSON your coaching platform returns, the extension attaches
`chrome.debugger` to the active tab and enables **only** the CDP `Network`
domain. The instant it attaches, Chrome shows its own yellow banner across the
top of the tab:

> "**&lt;Extension&gt; started debugging this browser.**"

That banner is Chrome's, not ours, and it cannot be hidden — that is the point.
It is your guarantee that capture is active and visible. It stays up for the
whole capture session and disappears the moment capture stops.

Capture is **passive**: we observe `Network.requestWillBeSent`,
`Network.responseReceived`, and `Network.loadingFinished`, then fetch JSON
response bodies with `Network.getResponseBody`. We never enable the `Fetch`
domain, so no request is ever paused, rewritten, or blocked — your normal
browsing runs at full speed while capture is on.

Before anything is stored, sensitive material is redacted: `Authorization`,
`Cookie`, and `Set-Cookie` headers and token-bearing URL query params
(`token`, `access_token`, `id_token`, `api_key`, `auth`, `session`) are replaced
with `<redacted>`. Raw credentials never enter the capture buffer.

## If you dismiss the banner (graceful fallback)

You are always free to click **"Cancel"** on Chrome's debugging banner, or to
decline the debugger prompt in the first place. Dismissing it detaches the
debugger; the extension treats that as a normal end-of-capture signal
(`chrome.debugger.onDetach`) and releases the tab's buffer cleanly — nothing is
left attached and no data is lost beyond what had not yet been captured.

When the debugger is unavailable because you declined it, the importer falls
back to a **`webRequest`-only** path. `webRequest` can observe request and
response *metadata* (URLs, methods, status codes, headers) without attaching a
debugger and without showing the banner, but it **cannot read response bodies**.
In fallback mode the importer can still detect which platform you are on and
surface what it sees, but full body capture requires the debugger path. The
choice is always yours: no banner, no body capture.

## Out of scope for v0.3

Streaming responses are **out of scope for v0.3**: Server-Sent Events (SSE),
WebSocket frames, chunked/streamed bodies, and any long-lived connection whose
body never "finishes" are not captured. Layer 1 finalizes an entry only on
`Network.loadingFinished` and reads the body once via `Network.getResponseBody`,
which does not model incremental or push-style payloads. Support for streaming
transports may be revisited in a later version.

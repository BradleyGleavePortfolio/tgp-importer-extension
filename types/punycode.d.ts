declare module "punycode";

declare namespace chrome.debugger {
  function sendCommand(
    target: Debuggee,
    method: "Network.getResponseBody",
    commandParams: { requestId: string },
  ): Promise<{ body: string; base64Encoded?: boolean }>;
}

// Node built-ins that @types/node re-imports by bare specifier. Pinned here so
// a stray package of the same name in an ancestor node_modules cannot be
// pulled into the checked program (same class of defect as punycode above).
declare module "string_decoder";

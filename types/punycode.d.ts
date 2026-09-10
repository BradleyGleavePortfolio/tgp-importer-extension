declare module "punycode";

declare namespace chrome.debugger {
  function sendCommand(
    target: Debuggee,
    method: "Network.getResponseBody",
    commandParams: { requestId: string },
  ): Promise<{ body: string; base64Encoded?: boolean }>;
}

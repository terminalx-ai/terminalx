/** Keep legacy pairings usable and resolve Bonjour names on every dial. */
export function directEndpoints(host: { endpoint: string; directEndpoints?: string[] }): string[] {
  // Version-2 offers carry an endpoint even when the server only has Relay.
  return [...new Set([...(host.directEndpoints ?? []), host.endpoint])].filter((endpoint) => endpoint !== "ws://127.0.0.1:0");
}

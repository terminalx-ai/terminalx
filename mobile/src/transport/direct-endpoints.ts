/** Keep legacy pairings usable and resolve Bonjour names on every dial. */
export function directEndpoints(host: { endpoint: string; directEndpoints?: string[] }): string[] {
  return [...new Set([...(host.directEndpoints ?? []), host.endpoint])];
}

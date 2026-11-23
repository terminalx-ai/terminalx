/**
 * The phone fixture's cloud setup (25.01–25.06): each area answers the requests
 * of its own screens in memory, so every state a board draws can be shown
 * without a network. `fixture-cloud.tsx` asks each area in turn before its own
 * answers; an area that returns nothing leaves the request to the next.
 */
export interface SetupRequest {
  method: string;
  /** The path as the client sent it, for example `/v1/mobile/orgs/org-acme/cloud-providers`. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** The JSON body, or null when there is none or it is not JSON. */
  body: unknown;
  /** A launch argument of the flow (`arguments: { name: value }`), if it was given. */
  argument(name: string): string | undefined;
  /** An answer in the service's JSON form. */
  json(status: number, body: unknown): Response;
}

export type SetupHandler = (request: SetupRequest) => Response | undefined | Promise<Response | undefined>;

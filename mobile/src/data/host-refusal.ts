/**
 * The Mac refused a request: its own message, and its code for the
 * connection log. Apart from `host-api` so that what only reads it does not
 * load the API and what it loads.
 */
export class HostRefusal extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HostRefusal";
  }
}

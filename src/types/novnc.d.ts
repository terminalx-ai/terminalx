/** The parts of noVNC's RFB client the Computer tab uses (`@novnc/novnc` ships no types). */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string; username?: string }; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    sendCredentials(credentials: { password?: string; username?: string }): void;
    disconnect(): void;
    focus(): void;
  }
}

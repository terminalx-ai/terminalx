/** The parts of noVNC's RFB client the Computer tab uses (`@novnc/novnc` ships no types). */
declare module "@novnc/novnc" {
  export interface RawChannel {
    binaryType: string;
    protocol: string;
    readyState: string;
    onopen: (() => void) | null;
    onclose: ((event: { clean: boolean }) => void) | null;
    onerror: ((error: unknown) => void) | null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    send(data: Uint8Array): void;
    close(): void;
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | RawChannel, options?: { credentials?: { password?: string; username?: string }; shared?: boolean });
    viewOnly: boolean;
    qualityLevel: number;
    compressionLevel: number;
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

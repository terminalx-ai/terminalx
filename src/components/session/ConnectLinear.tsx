import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LoaderCircle, LogoLinear } from "@/icons";
import { Button } from "@/components/ui/button";
import { errorMessage, issues as issuesApi } from "@/lib/api";

const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";

/** Linear has no key yet: say what it is for, and take one here. */
export function ConnectLinear({ onConnected }: { onConnected: () => void }) {
  const [entering, setEntering] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const status = await issuesApi.linearSetApiKey(key.trim());
      if (status.connected) onConnected();
      else setError("Linear did not accept that key.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-2 px-6 pb-5 pt-4 text-center" data-testid="connect-linear">
      <LogoLinear className="size-7 text-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">Connect Linear</p>
      <p className="max-w-[36ch] text-xs leading-relaxed text-muted-foreground">Start sessions from your Linear issues. TerminalX reads them with a personal API key, kept on this computer.</p>
      {entering ? (
        <form
          className="mt-1 flex w-full max-w-sm flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input
            autoFocus
            type="password"
            aria-label="Linear API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="lin_api_…"
            className="h-8 w-full rounded-md bg-well px-2.5 font-mono text-xs outline-none ring-1 ring-hairline placeholder:text-faint focus:ring-ring/60"
          />
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void openUrl(LINEAR_KEYS_URL).catch(() => {})}>
              Create a key in Linear
            </button>
            <Button size="sm" type="submit" disabled={!key.trim() || saving}>
              {saving && <LoaderCircle className="animate-spin" />}
              Connect
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-left text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      ) : (
        <Button size="sm" className="mt-1 gap-1.5" onClick={() => setEntering(true)}>
          <LogoLinear aria-hidden /> Connect Linear
        </Button>
      )}
    </div>
  );
}

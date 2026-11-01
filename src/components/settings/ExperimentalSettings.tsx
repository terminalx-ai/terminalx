import { useEffect, useState } from "react";
import { SettingRow, Switch } from "@/components/ui/controls";
import { errorMessage, experimental } from "@/lib/api";

export const NATIVE_CODEX_DESCRIPTION =
  "New Codex sessions connect to Codex directly instead of running it in a terminal, so the chat reliably shows when Codex is compacting its context. The chat is the main view: opening a session's terminal view moves that session to Codex's own terminal for good. Needs Codex 0.164.0 or newer; otherwise new sessions use the terminal as usual. Existing sessions and other agents are not changed.";

/** Features that are on only when the reader turns them on. */
export function ExperimentalTab() {
  const [nativeCodex, setNativeCodex] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => experimental.settings())
      .then((settings) => live && setNativeCodex(settings?.nativeCodex ?? false))
      .catch((e: unknown) => {
        if (!live) return;
        setNativeCodex(false);
        setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const change = async (on: boolean) => {
    const before = nativeCodex;
    setNativeCodex(on);
    setError(null);
    try {
      setNativeCodex((await experimental.setNativeCodex(on)).nativeCodex);
    } catch (e) {
      setNativeCodex(before);
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col" data-testid="experimental-settings">
      <p className="pb-3 text-[13px] text-muted-foreground">These features are still being tested. Turn one off at any time; sessions it already started keep working.</p>
      <SettingRow
        label="Native Codex"
        description={NATIVE_CODEX_DESCRIPTION}
        control={<Switch aria-label="Native Codex" checked={nativeCodex ?? false} disabled={nativeCodex === null} onCheckedChange={(on) => void change(on)} />}
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

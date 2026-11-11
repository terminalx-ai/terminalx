import { useSettingsFile } from "@/lib/settingsFile";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Switch } from "@/components/ui/controls";
import { errorMessage, experimental } from "@/lib/api";
import { noteExperimental } from "@/lib/experimental";

export { NATIVE_CODEX_DESCRIPTION, ORCHESTRATOR_RUNS_DESCRIPTION } from "./settingsRegistry";

/** Features that are on only when the reader turns them on. */
export function ExperimentalTab() {
  const { revision } = useSettingsFile();
  const [nativeCodex, setNativeCodex] = useState<boolean | null>(null);
  const [orchestratorRuns, setOrchestratorRuns] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => experimental.settings())
      .then((settings) => {
        if (!live) return;
        setNativeCodex(settings?.nativeCodex ?? false);
        setOrchestratorRuns(settings?.orchestratorRuns ?? false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setNativeCodex(false);
        setOrchestratorRuns(false);
        setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [revision]);

  // A paired phone can change it too (Settings → This Mac on the phone).
  useEffect(() => {
    let live = true;
    const unlisten = listen<{ nativeCodex?: boolean; orchestratorRuns?: boolean }>("experimental_settings_changed", (event) => {
      if (live && typeof event.payload?.nativeCodex === "boolean") setNativeCodex(event.payload.nativeCodex);
      if (live && typeof event.payload?.orchestratorRuns === "boolean") setOrchestratorRuns(event.payload.orchestratorRuns);
    }).catch(() => null);
    return () => {
      live = false;
      void unlisten.then((stop) => stop?.());
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

  const changeRuns = async (on: boolean) => {
    const before = orchestratorRuns;
    setOrchestratorRuns(on);
    setError(null);
    try {
      const saved = await experimental.setOrchestratorRuns(on);
      setOrchestratorRuns(saved.orchestratorRuns);
      // The Run view and Settings → Orchestrator appear at once, not when the file watcher gets to it.
      noteExperimental(saved);
    } catch (e) {
      setOrchestratorRuns(before);
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col" data-testid="experimental-settings">
      <p className="pb-3 text-[13px] text-muted-foreground">These features are still being tested. Turn one off at any time; sessions it already started keep working.</p>
      <RegisteredSetting setting="experimental.nativeCodex"
        control={<Switch aria-label="Native Codex" checked={nativeCodex ?? false} disabled={nativeCodex === null} onCheckedChange={(on) => void change(on)} />}
      />
      <RegisteredSetting setting="experimental.orchestratorRuns"
        control={<Switch aria-label="Orchestration runs" checked={orchestratorRuns ?? false} disabled={orchestratorRuns === null} onCheckedChange={(on) => void changeRuns(on)} />}
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

import { useSettingsFile } from "@/lib/settingsFile";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Switch } from "@/components/ui/controls";
import { errorMessage, experimental, type ExperimentalSettings } from "@/lib/api";
import { noteExperimentalSettings } from "@/lib/experimentalSettings";
import { refreshModels } from "@/lib/models";
import { refreshHarnesses } from "@/lib/sessions";
import { familyNow } from "@/lib/platform";

export { NATIVE_CODEX_DESCRIPTION, ORCHESTRATOR_RUNS_DESCRIPTION } from "./settingsRegistry";

/** Features that are on only when the reader turns them on. */
export function ExperimentalTab() {
  const { revision } = useSettingsFile();
  const [nativeCodex, setNativeCodex] = useState<boolean | null>(null);
  const [sessionCost, setSessionCost] = useState<boolean | null>(null);
  const [orchestratorRuns, setOrchestratorRuns] = useState<boolean | null>(null);
  const [localVmTasks, setLocalVmTasks] = useState<boolean | null>(null);
  const [openCode, setOpenCode] = useState<boolean | null>(null);
  const [bots, setBots] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<{ localVmTasks?: string; bots?: string }>({});

  // What cannot be on here, as the runtime says: Bots on Windows, Local VM
  // tasks off a Mac with Apple silicon. An older runtime cannot say: Windows
  // is known to have neither.
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => experimental.unsupported())
      .then((reasons) => { if (live) setUnsupported(reasons ?? {}); })
      .catch(() => {
        if (live && familyNow() === "windows") setUnsupported({ localVmTasks: "Local VM tasks need a Mac with Apple silicon, or Linux.", bots: "Bots are not available on Windows yet." });
      });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => experimental.settings())
      .then((settings) => {
        if (!live) return;
        setNativeCodex(settings?.nativeCodex ?? false);
        setSessionCost(settings?.sessionCost ?? false);
        setOrchestratorRuns(settings?.orchestratorRuns ?? false);
        setLocalVmTasks(settings?.localVmTasks ?? false);
        setOpenCode(settings?.opencode ?? false);
        setBots(settings?.bots ?? false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setNativeCodex(false);
        setSessionCost(false);
        setOrchestratorRuns(false);
        setLocalVmTasks(false);
        setBots(false);
        setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [revision]);

  // A paired phone can change it too (Settings → This Mac on the phone).
  useEffect(() => {
    let live = true;
    const unlisten = listen<{ nativeCodex?: boolean; sessionCost?: boolean; orchestratorRuns?: boolean; localVmTasks?: boolean; opencode?: boolean; bots?: boolean }>("experimental_settings_changed", (event) => {
      if (live && typeof event.payload?.bots === "boolean") setBots(event.payload.bots);
      if (live && typeof event.payload?.opencode === "boolean") setOpenCode(event.payload.opencode);
      if (live && typeof event.payload?.nativeCodex === "boolean") setNativeCodex(event.payload.nativeCodex);
      if (live && typeof event.payload?.sessionCost === "boolean") setSessionCost(event.payload.sessionCost);
      if (live && typeof event.payload?.orchestratorRuns === "boolean") setOrchestratorRuns(event.payload.orchestratorRuns);
      if (live && typeof event.payload?.localVmTasks === "boolean") setLocalVmTasks(event.payload.localVmTasks);
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
      const saved = await experimental.setNativeCodex(on);
      setNativeCodex(saved.nativeCodex);
      noteExperimentalSettings(saved);
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
      setOrchestratorRuns(saved.orchestratorRuns ?? false);
      // The Run view and Settings → Orchestrator appear at once, not when the file watcher gets to it.
      noteExperimentalSettings(saved);
    } catch (e) {
      setOrchestratorRuns(before);
      setError(errorMessage(e));
    }
  };

  const changeLocalVmTasks = async (on: boolean) => {
    const before = localVmTasks;
    setLocalVmTasks(on);
    setError(null);
    try {
      const saved = await experimental.setLocalVmTasks(on);
      setLocalVmTasks(saved.localVmTasks ?? false);
      // Settings → Local VMs and the Computer tab's choice follow at once.
      noteExperimentalSettings(saved);
    } catch (e) {
      setLocalVmTasks(before);
      setError(errorMessage(e));
    }
  };

  const changeOpenCode = async (on: boolean) => {
    const before = openCode;
    setOpenCode(on);
    setError(null);
    try {
      const saved = await experimental.setOpenCode(on);
      setOpenCode(saved.opencode ?? false);
      noteExperimentalSettings(saved);
      // Settings → Agents, the agent pickers and the model picker offer OpenCode, or stop offering it, at once (PRO-157).
      await Promise.all([refreshHarnesses(), refreshModels()]);
    } catch (e) {
      setOpenCode(before);
      setError(errorMessage(e));
    }
  };

  const changeBots = async (on: boolean) => {
    const before = bots;
    setBots(on);
    setError(null);
    try {
      const saved = await experimental.setBots(on);
      setBots(saved.bots ?? false);
      // The bots' store starts, or stops, at once (AppShell), not when the file watcher gets to it.
      noteExperimentalSettings(saved);
    } catch (e) {
      setBots(before);
      setError(errorMessage(e));
    }
  };

  const changeSessionCost = async (on: boolean) => {
    const before = sessionCost;
    setSessionCost(on);
    setError(null);
    try {
      const saved: ExperimentalSettings = await experimental.setSessionCost(on);
      setSessionCost(saved.sessionCost ?? false);
      noteExperimentalSettings(saved);
    } catch (e) {
      setSessionCost(before);
      setError(errorMessage(e));
    }
  };

  const vmOff = unsupported.localVmTasks;
  const botsOff = unsupported.bots;

  return (
    <div className="flex flex-col" data-testid="experimental-settings">
      <RegisteredSetting setting="experimental.nativeCodex"
        control={<Switch aria-label="Native Codex" checked={nativeCodex ?? false} disabled={nativeCodex === null} onCheckedChange={(on) => void change(on)} />}
      />
      <RegisteredSetting setting="experimental.sessionCost"
        control={<Switch aria-label="Session cost" checked={sessionCost ?? false} disabled={sessionCost === null} onCheckedChange={(on) => void changeSessionCost(on)} />}
      />
      <RegisteredSetting setting="experimental.orchestratorRuns"
        control={<Switch aria-label="Orchestration runs" checked={orchestratorRuns ?? false} disabled={orchestratorRuns === null} onCheckedChange={(on) => void changeRuns(on)} />}
      />
      <RegisteredSetting setting="experimental.localVmTasks"
        control={<Switch aria-label="Local VM tasks" checked={!vmOff && (localVmTasks ?? false)} disabled={!!vmOff || localVmTasks === null} onCheckedChange={(on) => void changeLocalVmTasks(on)} />}
      />
      <RegisteredSetting setting="experimental.opencode"
        control={<Switch aria-label="OpenCode" checked={openCode ?? false} disabled={openCode === null} onCheckedChange={(on) => void changeOpenCode(on)} />}
      />
      <RegisteredSetting setting="experimental.bots"
        control={<Switch aria-label="Bots" checked={!botsOff && (bots ?? false)} disabled={!!botsOff || bots === null} onCheckedChange={(on) => void changeBots(on)} />}
      />
      {(vmOff || botsOff) && <p data-testid="experimental-unsupported-note" className="pb-2 text-xs text-muted-foreground">{[vmOff, botsOff].filter(Boolean).join(" ")}</p>}
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

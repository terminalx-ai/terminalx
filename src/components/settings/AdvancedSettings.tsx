// PRO-157, design 09.29: Settings → Advanced shows which Claude Code and Codex
// programs TerminalX runs. They are the same setting as each agent's
// Executable row in Settings → Agents.
import { useCallback } from "react";
import { refreshHarnesses } from "@/lib/sessions";
import { AgentExecutableRow } from "./AgentExecutable";
import { RegisteredSetting } from "./settingsRegistry";

export function AdvancedTab() {
  // A new program can change whether an agent is installed, for every picker.
  const changed = useCallback(() => { void refreshHarnesses().catch(() => {}); }, []);
  return <div className="flex flex-col" data-testid="advanced-settings">
    <RegisteredSetting setting="advanced.claudeExecutable">
      <div>
        <AgentExecutableRow harness="claude" agentName="Claude Code" title="Claude Code executable" resetLabel="Use system Claude Code"
          description="Leave empty to use the one on your PATH. TerminalX checks it with --version." onChanged={changed} />
      </div>
    </RegisteredSetting>
    <RegisteredSetting setting="advanced.codexExecutable">
      <div>
        <AgentExecutableRow harness="codex" agentName="Codex" title="Codex executable" resetLabel="Use system Codex"
          description="Leave empty to use the one on your PATH. TerminalX checks it with --version." onChanged={changed} last />
      </div>
    </RegisteredSetting>
  </div>;
}

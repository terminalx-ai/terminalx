import { IssueConfirmation } from "@/components/issues/IssueConfirmation";
import { LocalRuntimeNotice } from "@/components/LocalRuntimeNotice";
import { StartupDiagnostics } from "@/components/StartupDiagnostics";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { FloatingShell } from "@/components/floating/FloatingShell";
import { isCompactWindow } from "@/lib/appWindow";
import { useNativeMenus } from "@/lib/nativeMenuBridge";

/**
 * Every window loads this page. The main one draws the workbench; chat
 * windows draw sessions in a compact shell. Stores run per window, and the
 * backend is the shared source of truth.
 */
export default function App() {
  useNativeMenus();
  return <TooltipProvider>{isCompactWindow() ? <FloatingShell /> : <><AppShell /><IssueConfirmation /></>}<LocalRuntimeNotice /><StartupDiagnostics /></TooltipProvider>;
}

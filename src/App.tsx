import { lazy, Suspense } from "react";
import { LocalRuntimeNotice } from "@/components/LocalRuntimeNotice";
import { StartupDiagnostics } from "@/components/StartupDiagnostics";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { isCompactWindow } from "@/lib/appWindow";
import { useNativeMenus } from "@/lib/nativeMenuBridge";
import { useGitForWindowsCheck } from "@/lib/gitForWindows";

const FloatingShell = lazy(() => import("@/components/floating/FloatingShell").then((m) => ({ default: m.FloatingShell })));
const IssueConfirmation = lazy(() => import("@/components/issues/IssueConfirmation").then((m) => ({ default: m.IssueConfirmation })));
const SupportReportDialog = lazy(() => import("@/components/SupportReportDialog").then((m) => ({ default: m.SupportReportDialog })));

/**
 * Every window loads this page. The main one draws the workbench; chat
 * windows draw sessions in a compact shell. Stores run per window, and the
 * backend is the shared source of truth.
 */
export default function App() {
  useNativeMenus();
  useGitForWindowsCheck();
  return (
    <TooltipProvider>
      {isCompactWindow() ? (
        <Suspense fallback={null}>
          <FloatingShell />
        </Suspense>
      ) : (
        <>
          <AppShell />
          <Suspense fallback={null}>
            <IssueConfirmation />
            <SupportReportDialog />
          </Suspense>
        </>
      )}
      <LocalRuntimeNotice />
      <StartupDiagnostics />
      <ConfirmDialogHost />
    </TooltipProvider>
  );
}

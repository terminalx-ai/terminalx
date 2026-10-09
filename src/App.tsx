import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { FloatingShell } from "@/components/floating/FloatingShell";
import { isFloatingWindow } from "@/lib/appWindow";

/**
 * Both windows load this page. The main one draws the workbench; the floating
 * one draws a session in a compact shell. They share every store, and the
 * backend is the source of truth for both.
 */
export default function App() {
  return <TooltipProvider>{isFloatingWindow() ? <FloatingShell /> : <AppShell />}</TooltipProvider>;
}

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { advanceIntro, finishIntro, INTRO_STEPS, previousIntro, useIntro } from "@/lib/intro";
import { EmptyView } from "./EmptyView";

const slides = [
  { title: "Your agents, one workspace", body: "Bring your coding agents together in TerminalX. Add a project, choose an agent, and start a conversation with the code beside it." },
  { title: "Make room for parallel work", body: "Give each task its own session and worktree. Switch between conversations in the sidebar while your agents keep working." },
  { title: "Stay in control", body: "Review changes, run commands, and answer permission requests in the same workspace. Use the command palette to find an action whenever you need it." },
];

export function IntroSlides() {
  const { step } = useIntro();
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { surface.current?.focus(); }, []);
  const slide = slides[step];
  return <div ref={surface} tabIndex={-1} aria-label="Introduction" className="flex min-h-0 flex-1 flex-col outline-none"
    onKeyDown={(event) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // A focused button keeps native Enter activation (especially Skip and Back).
      if (event.key === "ArrowDown" || (event.key === "Enter" && event.target === event.currentTarget)) {
        event.preventDefault(); event.stopPropagation(); advanceIntro();
      }
    }}>
    <EmptyView branded guidance="A quick introduction">
      <section aria-live="polite" aria-atomic="true" className="mx-auto mt-8 max-w-md text-center">
        <p className="text-xs text-muted-foreground">Step {step + 1} of {INTRO_STEPS}</p>
        <h2 className="mt-3 text-xl font-semibold">{slide.title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{slide.body}</p>
      </section>
      <div className="mx-auto mt-8 flex max-w-md flex-wrap items-center justify-center gap-3">
        <Button variant="ghost" onClick={finishIntro}>Skip</Button>
        <Button variant="secondary" disabled={step === 0} onClick={previousIntro}>Back</Button>
        <Button variant="accent" onClick={advanceIntro}>{step === INTRO_STEPS - 1 ? "Finish" : "Next"}</Button>
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground">↓ or ↵ to continue · Revisit from Help → Introduction</p>
    </EmptyView>
  </div>;
}

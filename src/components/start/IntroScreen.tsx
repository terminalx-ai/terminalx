import { useEffect, useRef, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import appMark from "../../../src-tauri/icons/128x128.png";
import {
  ArrowDown, ArrowRight, ArrowUp, Bell, Check, CircleCheck, CircleHelp, CornerDownLeft, FolderOpen, GitBranch, GitMerge,
  Loader2, LoaderCircle, MessageSquare, ShieldAlert, Smartphone, Sparkles, Users, type LucideIcon,
} from "@/icons";
import { Button } from "@/components/ui/button";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { signIn, useAccount } from "@/lib/account";
import { cn } from "@/lib/cn";
import { INTRO_LAST_STEP, finishIntro, holdIntro, setIntroStep } from "@/lib/intro";
import { usePrefs } from "@/lib/prefs";
import { repoFile } from "@/lib/repo";

const SITE = "https://terminalx.ai";

interface Slide {
  title: string;
  body: string;
  picture: () => ReactNode;
}

const SLIDES: Slide[] = [
  {
    title: "Run agents side by side",
    body: "Each session gets its own worktree and branch, so Claude Code and Codex can work at the same time without touching each other's files.",
    picture: SessionsPicture,
  },
  {
    title: "See what needs you",
    body: "Approvals, questions and finished work collect in one place. Answer from the keyboard, or from your phone when you're away.",
    picture: NeedsYouPicture,
  },
  {
    title: "Review and ship",
    body: "Read the diff, watch the checks and merge from the same window. Ask for changes in a comment and the agent picks them up.",
    picture: ReviewPicture,
  },
];

const READY: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: FolderOpen, title: "Open a project", detail: "Pick a folder or clone from GitHub. Works without an account." },
  { icon: Smartphone, title: "Pair your phone", detail: "Answer approvals and questions away from your Mac. Needs an account." },
  { icon: Users, title: "Join your team", detail: "Accept an invitation and use the organization's cloud workspaces. Needs an account." },
];

/** Keys typed into a field, or in a dialog over the screen, are theirs; so is ↵ on a focused button or link. */
function ownKeys(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']") || document.querySelector("[role='dialog']")) return true;
  return event.key === "Enter" && !!target?.closest("button, a");
}

/**
 * The first-run intro beside sign-in (PRO-241: 01.02, 01.14–01.16). ↓ and ↵ go on, ↑ goes back; the step is saved as it
 * changes, so a quit comes back to it. There is no Skip (owner, 2026-11-26): signing in, or Continue without an account,
 * ends it.
 */
export function IntroScreen() {
  const { introStep: step } = usePrefs();
  const account = useAccount();
  const signedIn = account.status.state === "signed-in";
  const wasSignedIn = useRef(signedIn);
  const ready = step >= INTRO_LAST_STEP;
  const go = (next: number) => setIntroStep(next);

  useEffect(() => holdIntro(), []);

  // A sign-in that finishes while it is up ends it. Shown again from Help while signed in, Continue does.
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) finishIntro();
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || ownKeys(event)) return;
      if (event.key === "ArrowDown" && !ready) go(step + 1);
      else if (event.key === "ArrowUp" && step > 0) go(step - 1);
      else if (event.key === "Enter") {
        if (ready) finishIntro();
        else go(step + 1);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, ready]);

  const slide = SLIDES[Math.min(step, SLIDES.length - 1)];
  return (
    <div data-testid="intro-screen" data-step={step} className="relative flex h-full min-h-0 w-full text-[13px] leading-5">
      <div data-tauri-drag-region="deep" className="absolute inset-x-0 top-0 h-(--titlebar-h)" />
      <section aria-label="Intro" className="flex min-w-0 flex-1 flex-col overflow-y-auto px-[72px] pb-10 pt-[88px]">
        <div className="w-full max-w-[600px]">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <PrivacyImage src={appMark} alt="" className="size-6 rounded-md" />
            <span className="text-foreground/80">TerminalX</span>
            <span aria-live="polite">· {ready ? "ready" : `${step + 1} of ${SLIDES.length}`}</span>
          </p>
          <h1 className="mt-5 text-[30px] font-semibold leading-9 tracking-tight">{ready ? "Ready when you are" : slide.title}</h1>
          <p className="mt-2 max-w-[500px] text-[14px] leading-[22px] text-muted-foreground">
            {ready ? "That's the tour. An account is optional: local projects and agents work without one." : slide.body}
          </p>
          <div className="mt-8 max-w-[560px]">
            {ready ? <ReadyStep /> : <Window>{slide.picture()}</Window>}
          </div>
          <Stepper step={step} onGo={go} />
        </div>
      </section>
      <SignInPanel ready={ready} />
    </div>
  );
}

function Stepper({ step, onGo }: { step: number; onGo: (step: number) => void }) {
  const ready = step >= INTRO_LAST_STEP;
  return (
    <div className="mt-10 flex max-w-[600px] items-center gap-6">
      <div aria-hidden className="flex w-12 items-center gap-1">
        {SLIDES.map((_, index) => (
          <span key={index} className={cn("h-1 rounded-full transition-all", index === step ? "w-6 bg-accent" : "w-1 bg-muted-foreground/60")} />
        ))}
      </div>
      <ol aria-label="Slides" className="grid flex-1 gap-1.5">
        {SLIDES.map((item, index) => {
          const done = index < step;
          return (
            <li key={item.title} aria-current={index === step ? "step" : undefined} className="flex items-center gap-4">
              <span className="flex w-3 justify-center text-xs text-muted-foreground">
                {done ? <Check aria-label="Done" className="size-3.5 text-add" /> : index + 1}
              </span>
              <span className={index === step ? "text-foreground" : "text-muted-foreground"}>{item.title}</span>
            </li>
          );
        })}
      </ol>
      {ready ? (
        <Button variant="ghost" size="sm" onClick={() => onGo(step - 1)}>
          <Keycap><ArrowUp /></Keycap> Back
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => onGo(step + 1)}>
          <Keycap><ArrowDown /></Keycap> {step === SLIDES.length - 1 ? "Last step" : "Next"}
        </Button>
      )}
    </div>
  );
}

function SignInPanel({ ready }: { ready: boolean }) {
  const account = useAccount();
  const identity = account.status.state === "signed-in" ? account.status.identity : null;
  const waiting = account.busy || account.status.state === "signing-in";
  return (
    <section aria-label="Sign in" className="relative flex w-[46%] min-w-[380px] max-w-[680px] shrink-0 flex-col border-l border-hairline bg-card">
      <div className="flex h-(--titlebar-h) shrink-0 items-center justify-end px-3">
        <Button variant="ghost" size="sm" onClick={() => void openUrl(repoFile("README.md"))}><CircleHelp /> Help</Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-10">
        <div className="mx-auto w-full max-w-[380px]">
          <PrivacyImage src={appMark} alt="" className="size-10 rounded-lg" />
          <h2 className="mt-5 text-[22px] font-semibold leading-7">Sign in to TerminalX</h2>
          {identity ? (
            <>
              <p className="mt-1 text-muted-foreground">Signed in as {identity.name || identity.email}.</p>
              <Button size="lg" className="mt-6 w-full" onClick={finishIntro}>Continue</Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-muted-foreground">
                Optional. An account pairs your phone, lets you join your team's organization and runs cloud workspaces. Local projects and agents work without one.
              </p>
              <Button size="lg" className="mt-6 w-full" disabled={waiting} onClick={() => void signIn()}>
                {waiting ? <><Loader2 className="animate-spin" /> Waiting for your browser…</> : "Sign in"}
              </Button>
              {account.status.lastError && <p role="alert" className="mt-2 text-xs text-destructive">{account.status.lastError}</p>}
              <Button variant="outline" size="lg" className="mt-6 w-full border-dashed font-normal text-muted-foreground" onClick={finishIntro}>
                Continue without an account <ArrowRight />
              </Button>
              <p className="mt-6 text-xs text-muted-foreground">
                Sign-in finishes in your browser. By continuing you agree to the TerminalX{" "}
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(`${SITE}/terms`)}>terms</button> and{" "}
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => void openUrl(`${SITE}/privacy`)}>privacy policy</button>.
              </p>
            </>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-5 pb-5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Keycap>{ready ? <ArrowUp /> : <ArrowDown />}</Keycap> {ready ? "previous slide" : "next slide"}
        </span>
        <span className="flex items-center gap-1.5"><Keycap><CornerDownLeft /></Keycap> continue</span>
        <button type="button" className="hover:text-foreground" onClick={() => void openUrl(`${SITE}/privacy`)}>Privacy</button>
      </footer>
    </section>
  );
}

function Keycap({ children }: { children: ReactNode }) {
  return <kbd aria-hidden className="inline-flex size-4 items-center justify-center rounded border border-hairline-strong [&_svg]:size-2.5">{children}</kbd>;
}

function ReadyStep() {
  return (
    <div>
      <ul className="grid gap-2.5">
        {READY.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex gap-3 rounded-xl border border-border bg-raised px-4 py-3">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="block font-medium">{title}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex gap-3 text-[12.5px] text-muted-foreground">
        <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
        Sign in on the right, or continue without an account. You can see this intro again from Help › Show intro.
      </p>
    </div>
  );
}

/** The slides' pictures: drawn the way the app draws these things, with made-up projects in them. */
function Window({ children }: { children: ReactNode }) {
  return <div aria-hidden className="overflow-hidden rounded-xl border border-border bg-background text-xs shadow-lg">{children}</div>;
}

function WindowBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline px-3 py-2 text-[11.5px] text-muted-foreground">
      <span className="flex gap-1">{[0, 1, 2].map((dot) => <span key={dot} className="size-2 rounded-full bg-muted-foreground/40" />)}</span>
      {children}
    </div>
  );
}

function SessionsPicture() {
  const rows = [
    { icon: <LoaderCircle className="size-4 text-accent" />, title: "Fix duplicate permission cards", branch: "dedupe-permission-cards", agent: "Claude Code", state: "Editing AskCards.tsx" },
    { icon: <ShieldAlert className="size-4 text-destructive" />, title: "Show the diff inside edit approvals", branch: "approval-diff", agent: "Codex", state: "Waiting for you · 2 files" },
    { icon: <GitMerge className="size-4 text-add" />, title: "Notarize release builds", branch: "notarize-release", agent: "Claude Code", state: "Checks passed" },
  ];
  return (
    <>
      <WindowBar>acme · 3 sessions</WindowBar>
      {rows.map((row) => (
        <div key={row.title} className="flex items-center gap-3 border-b border-hairline px-3.5 py-2.5">
          {row.icon}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] text-foreground">{row.title}</span>
            <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><GitBranch className="size-3" />{row.branch}</span>
          </span>
          <span className="text-right text-[11px] text-muted-foreground">
            <span className="flex items-center justify-end gap-1 text-foreground/80"><Sparkles className="size-3" />{row.agent}</span>
            {row.state}
          </span>
        </div>
      ))}
      <pre className="bg-terminal px-3.5 py-3 font-mono text-[11px] leading-[17px] text-muted-foreground">
        <span className="text-add">you@mac</span> acme % git worktree list{"\n"}
        ~/src/acme            a7d93c2 [main]{"\n"}
        …/worktrees/dedupe-permission-cards 9c1e2aa [dedupe-permission-cards]{"\n"}
        …/worktrees/approval-diff           41f0b7d [approval-diff]{"\n"}
        …/worktrees/notarize-release        ede0b4d [notarize-release]
      </pre>
    </>
  );
}

function NeedsYouPicture() {
  return (
    <>
      <WindowBar>Needs you · 2</WindowBar>
      <div className="flex items-center gap-3 border-b border-hairline bg-veil-raised px-3.5 py-2.5">
        <ShieldAlert className="size-4 text-destructive" />
        <span className="flex-1">
          <span className="block text-[12.5px] text-foreground">Show the diff inside edit approvals</span>
          <span className="text-[11px] text-muted-foreground">Codex wants to edit AskCards.tsx</span>
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Keycap><CornerDownLeft /></Keycap> allow</span>
      </div>
      <div className="flex items-center gap-3 border-b border-hairline px-3.5 py-2.5">
        <CircleHelp className="size-4 text-warning" />
        <span className="flex-1">
          <span className="block text-[12.5px] text-foreground">Notarize release builds</span>
          <span className="text-[11px] text-muted-foreground">Claude Code asks: keep the old signing identity?</span>
        </span>
        <span className="text-[11px] text-muted-foreground">answer</span>
      </div>
      <div className="m-3.5 rounded-lg border border-destructive/50">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <ShieldAlert className="size-3.5 text-destructive" />
          <span className="text-[10.5px] font-semibold tracking-wide text-destructive">APPROVAL</span>
          <span className="text-foreground">Edit AskCards.tsx?</span>
        </div>
        <pre className="px-3 py-2 font-mono text-[11px] leading-[17px]">
          <span className="text-destructive">- return events.map(toCard);</span>{"\n"}
          <span className="text-add">+ return dedupeByToolUse(events).map(toCard);</span>
        </pre>
        <div className="flex justify-between border-t border-hairline px-3 py-2">
          <span className="rounded-md border border-border px-2 py-0.5 text-muted-foreground">Deny</span>
          <span className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-0.5 font-medium text-accent-foreground">Allow <CornerDownLeft className="size-3" /></span>
        </div>
      </div>
      <p className="flex items-center gap-2 px-3.5 pb-3 text-[11px] text-muted-foreground">
        <Bell className="size-3" /> A sound and a notification when an agent waits, and the same card on your phone.
      </p>
    </>
  );
}

function ReviewPicture() {
  const files = [
    { mark: "M", name: "AskCards.tsx", lines: "+18" },
    { mark: "A", name: "AskCards.test.tsx", lines: "+36" },
    { mark: "M", name: "events.rs", lines: "+3" },
  ];
  const checks = [["test / bun", "48s"], ["typecheck", "31s"], ["lint", "14s"]];
  return (
    <>
      <WindowBar>Show the diff inside edit approvals · PR #781</WindowBar>
      <div className="grid grid-cols-2">
        <ul className="border-r border-hairline py-1">
          {files.map((file, index) => (
            <li key={file.name} className={cn("flex items-center gap-3 px-3.5 py-2 font-mono text-[11.5px]", index === 0 && "bg-veil-raised")}>
              <span className="text-warning">{file.mark}</span>
              <span className="flex-1 text-foreground">{file.name}</span>
              <span className="text-add">{file.lines}</span>
            </li>
          ))}
        </ul>
        <div className="grid content-start gap-2 px-3.5 py-2.5">
          {checks.map(([name, time]) => (
            <span key={name} className="flex items-center gap-2 text-foreground">
              <CircleCheck className="size-3.5 text-add" /><span className="flex-1">{name}</span><span className="text-muted-foreground">{time}</span>
            </span>
          ))}
          <span className="mt-1 flex w-fit items-center gap-1.5 rounded-md bg-merge px-2.5 py-1 font-medium text-merge-foreground"><GitMerge className="size-3.5" /> Merge</span>
        </div>
      </div>
      <p className="flex items-center gap-2 border-t border-hairline px-3.5 py-2.5 text-[11px] text-muted-foreground">
        <MessageSquare className="size-3" /> Comment on a line and the agent fixes it in the same branch.
      </p>
    </>
  );
}

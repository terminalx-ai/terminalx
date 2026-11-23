import { useEffect, useRef, useState, type ReactNode } from "react";
import { ThisComputer } from "@/lib/platform";
import { BookOpen, Check, CheckCircle2, Copy, LoaderCircle, Terminal } from "@/icons";
import { Button } from "@/components/ui/button";
import { minutesSeconds } from "@/components/pairing/pairingText";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { MACHINE_CODE_PREFIX, MACHINE_CODE_TTL_MS } from "@/types/machines";
import { osLabel, soft } from "./machineText";
import { failureCopy, type MachinePairing } from "./useMachinePairing";

export const INSTALL_COMMAND = "curl -fsSL https://terminalx.ai/install.sh | sh";
export const PAIR_COMMAND = "terminalx-serve pair";
/** The transcript's shell prompt (21.06). The server's own user and host are not known here, so it names neither. */
export const SERVER_PROMPT = "you@server";

/** This Mac's name as other computers see it (Settings → Account), or null until it is read. */
function useThisMacName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.machineName())
      .then((found) => live && setName(found?.name ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return name;
}

/** A command to run on the server, mono, with a copy button. */
function CommandBox({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current != null && window.clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await copyText(command);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div data-command className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-hairline bg-raised pl-3 pr-1 font-mono text-[12px]">
      <span className="text-faint" aria-hidden>$</span>
      <code className="-mr-1 min-w-0 flex-1 truncate" title={command}>{command}</code>
      <Button variant="ghost" size="icon-xs" aria-label={copied ? `${label} copied` : `Copy ${label}`} onClick={() => void copy()} className="size-[22px] text-faint [&_svg]:size-[13px]">
        {copied ? <Check className="text-add" /> : <Copy />}
      </Button>
    </div>
  );
}

export function StepRow({ n, title, titleFor, children }: { n: number; title: string; titleFor?: string; children: ReactNode }) {
  const Title = titleFor ? "label" : "div";
  return (
    <li className="flex gap-3">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[12px] tabular-nums text-muted-foreground" aria-hidden>{n}</span>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Title htmlFor={titleFor} className="text-[12.5px] font-medium">{title}</Title>
        {children}
      </div>
    </li>
  );
}

/** A value the server prints that is not known here until a code is pasted. */
const Placeholder = ({ children }: { children: string }) => <span className="text-faint">{children}</span>;

/**
 * What `terminalx-serve pair` prints on the server. Before a code is pasted the
 * server's own values are placeholders; once a code is read they come from it.
 * The asking line names this Mac as the server will show it.
 */
function OnTheServer({ pairing, thisMac }: { pairing: MachinePairing; thisMac: string | null }) {
  const { inspected, code } = pairing;
  const machine = inspected?.machine ?? null;
  const ttl = minutesSeconds(MACHINE_CODE_TTL_MS / 1000);
  return (
    <section aria-label="On the server" data-terminal className="min-w-0 self-start overflow-hidden rounded-lg border border-hairline bg-terminal">
      <div className="flex h-8 items-center gap-2 border-b border-hairline px-3 text-[12px] text-faint">
        <Terminal className="size-[13px] shrink-0" aria-hidden /> On the server
      </div>
      <div className="grid px-3 py-2.5 font-mono text-[12px] leading-[19px] text-foreground" data-testid="server-transcript">
        <div className="whitespace-pre"><span className="text-info">{SERVER_PROMPT}</span> ~ $ {PAIR_COMMAND}</div>
        <div className="truncate text-muted-foreground">
          TerminalX {machine ? machine.version : <Placeholder>{"<version>"}</Placeholder>} · {machine ? osLabel(machine.os) : <Placeholder>{"<OS> <arch>"}</Placeholder>}
        </div>
        <div className="truncate text-muted-foreground">
          <span className="whitespace-pre">{"Name        "}</span>
          {machine ? <span className="text-foreground">{machine.name}</span> : <Placeholder>{"<server name>"}</Placeholder>}
        </div>
        <div className="truncate text-muted-foreground">
          <span className="whitespace-pre">{"Machine ID  "}</span>
          {machine ? <span className="text-foreground">{machine.machineId}</span> : <Placeholder>{"<machine ID>"}</Placeholder>}
        </div>
        <div aria-hidden>&nbsp;</div>
        <div className="text-muted-foreground">Pairing code, valid for {ttl}, works once:</div>
        <div className="truncate text-accent">{inspected ? code.trim() : `${MACHINE_CODE_PREFIX}…`}</div>
        <div aria-hidden>&nbsp;</div>
        <div className="text-muted-foreground">Waiting for a computer to pair…</div>
        <div className="flex gap-[1ch]">
          <span className="text-add" aria-hidden>✓</span>
          <span className="min-w-0 break-words">
            {thisMac ?? ThisComputer} asks to operate this server. Fingerprint{" "}
            <span className="whitespace-nowrap">{inspected ? <span className="text-foreground">{inspected.fingerprint}</span> : <Placeholder>{"<fingerprint>"}</Placeholder>}.</span>
          </span>
        </div>
        <div className="whitespace-pre pl-[2ch]">
          Allow? [y/N] <span className="inline-block h-[14px] w-[7px] translate-y-[2px] bg-foreground" aria-hidden />
        </div>
      </div>
    </section>
  );
}

/** Screen 21.06: install TerminalX on a server, make a code there with `terminalx-serve pair`, paste it, Continue. */
export function HeadlessServerTab({ pairing, onClose, onDone }: { pairing: MachinePairing; onClose: () => void; onDone: () => void }) {
  const { code, step, inspected, remaining, changeCode, ask } = pairing;
  const thisMac = useThisMacName();
  const name = inspected?.machine.name ?? "the server";
  const failure = step.kind === "failed" ? failureCopy(step.reason, name) : null;
  const codeLocked = step.kind === "waiting" || step.kind === "inspecting" || step.kind === "paired";
  const canContinue = step.kind === "ready" && remaining > 0;
  const canRetry = !!inspected && (failure?.retry || step.kind === "fault") && remaining > 0;

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_330px] gap-5 px-5 pb-5 pt-4 max-[799px]:grid-cols-1" data-testid="headless-server">
        <div className="grid min-w-0 content-start gap-4">
          <p className={soft}>A server runs TerminalX without a window. {ThisComputer} connects to it directly, on this network or over Tailscale, so its TCP port 6768 must be reachable from here.</p>
          <ol className="grid gap-4">
            <StepRow n={1} title="Install TerminalX on the server">
              <CommandBox command={INSTALL_COMMAND} label="install command" />
              <p className="text-[12px] leading-[18px] text-faint">Linux x64 and arm64, and macOS. Installs a user service that starts at boot.</p>
            </StepRow>
            <StepRow n={2} title="Create a pairing code there">
              <CommandBox command={PAIR_COMMAND} label="pair command" />
            </StepRow>
            <StepRow n={3} title="Paste the code here" titleFor="headless-code">
              <input
                id="headless-code"
                value={code}
                readOnly={codeLocked}
                spellCheck={false}
                autoComplete="off"
                placeholder="txm2.…"
                aria-invalid={step.kind === "invalid" || (step.kind === "failed" && step.reason === "invalid-code") ? true : undefined}
                onChange={(event) => void changeCode(event.target.value)}
                className={cn(
                  "h-9 w-full min-w-0 rounded-md border border-hairline bg-raised px-3 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring",
                  codeLocked && "text-muted-foreground",
                )}
              />
              <CodeStatus pairing={pairing} name={name} failure={failure} />
            </StepRow>
          </ol>
        </div>
        <OnTheServer pairing={pairing} thisMac={thisMac} />
      </div>
      <footer className="flex min-h-[52px] flex-wrap items-center gap-2 border-t border-hairline px-5 py-2.5">
        <span className="mr-auto flex items-center gap-1.5 text-[12px] text-faint">
          <BookOpen className="size-[13px] shrink-0" aria-hidden /> Agents sign in on the server after pairing, from its machine page.
        </span>
        {step.kind === "paired" ? (
          <Button size="sm" onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            {canRetry ? (
              <Button size="sm" onClick={ask}>Try again</Button>
            ) : (
              <Button size="sm" disabled={!canContinue} onClick={ask}>
                {step.kind === "waiting" && <LoaderCircle className="animate-spin" aria-hidden />} Continue
              </Button>
            )}
          </>
        )}
      </footer>
    </>
  );
}

/** Under the code: what was read, what happens now, and why it stopped. */
function CodeStatus({ pairing, name, failure }: { pairing: MachinePairing; name: string; failure: ReturnType<typeof failureCopy> | null }) {
  const { step, inspected, remaining } = pairing;
  if (step.kind === "empty") return null;
  if (step.kind === "inspecting") {
    return <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading the code…</div>;
  }
  if (step.kind === "invalid") {
    return (
      <div role="alert" className="grid gap-0.5 text-[12.5px]">
        <span className="font-medium text-destructive">This is not a machine pairing code</span>
        <span className="text-muted-foreground">{step.detail ?? `A machine’s code starts with ${MACHINE_CODE_PREFIX} Copy it again from what terminalx-serve pair printed.`}</span>
      </div>
    );
  }
  const expiry = step.kind === "paired" ? null : remaining > 0 ? `The code expires in ${minutesSeconds(remaining)} and works once.` : "The code has expired.";
  return (
    <div className="grid gap-1.5">
      {inspected && step.kind !== "paired" && (
        <p className={soft} aria-live="polite">
          From <span className="text-foreground">{inspected.machine.name}</span>. {expiry}
          {inspected.alreadyPaired && ` ${ThisComputer} is already paired with ${name}. Pairing again replaces its credential.`}
        </p>
      )}
      {step.kind === "ready" && remaining > 0 && <p className={soft}>Continue, then compare the fingerprint on the server and answer y there.</p>}
      {step.kind === "waiting" && (
        <div className="flex items-center gap-2 text-[12.5px] text-info" role="status">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden /> Waiting for approval on {name}…
        </div>
      )}
      {step.kind === "paired" && (
        <div className="grid gap-1" role="status">
          <div className="flex items-center gap-2 text-[13px] font-medium text-add"><CheckCircle2 className="size-4 shrink-0" aria-hidden /> Paired with {name}</div>
          <p className={soft}>It is in Your machines in Settings → Machines.</p>
        </div>
      )}
      {failure && (
        <div role="alert" className="grid gap-0.5 text-[12.5px]">
          <span className="font-medium text-destructive">{failure.title}</span>
          <span className="text-muted-foreground">{failure.detail}</span>
        </div>
      )}
      {step.kind === "fault" && (
        <div role="alert" className="grid gap-0.5 text-[12.5px]">
          <span className="font-medium text-destructive">Pairing stopped</span>
          <span className="break-words text-muted-foreground">{step.message}</span>
        </div>
      )}
    </div>
  );
}

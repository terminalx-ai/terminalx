import { useState } from "react";
import { foldShellOutput } from "@terminalx/portable/harnessText";
import type { WorkItem } from "@/lib/transcript";
import { copyText } from "@/lib/clipboard";
import { Check, Copy } from "@/icons";
import { LinkedText } from "./LinkedText";
import { useDisclosure, useSearchSection } from "./disclosures";

type Shell = Extract<WorkItem, { kind: "shell" }>;

/** Disclosure name of a shell block's long output; chat search opens it to show a match inside. */
export function shellOutputDisclosure(key: string): string {
  return `shell:${key}`;
}

/** What Copy puts on the clipboard: the command as typed at a prompt, then what it printed. */
export function shellCopyText(item: Shell): string {
  return [item.command !== undefined ? `$ ${item.command}` : "", item.stdout, item.stderr].filter(Boolean).join("\n");
}

/**
 * A command the reader ran through Claude Code's `!` (#1294), drawn like a
 * shell: `$ command`, then what it printed, stderr in red. Long output folds
 * behind "Show more"; an empty part draws nothing.
 */
export function ShellBlock({ item, linkContext }: { item: Shell; linkContext?: { sessionId: string; cwd: string } }) {
  const [open, setOpen] = useDisclosure(shellOutputDisclosure(item.key));
  const [copied, setCopied] = useState(false);
  const commandSection = useSearchSection(`${item.key}:command`);
  const outputSection = useSearchSection(`${item.key}:output`);
  const stdout = foldShellOutput(item.stdout);
  const stderr = foldShellOutput(item.stderr);
  const folded = stdout.folded || stderr.folded;
  const failed = item.exitCode !== undefined && item.exitCode !== 0;
  return (
    <div className="group/shell relative my-2 rounded-md bg-well font-mono text-[12px] leading-relaxed" data-testid="shell-block">
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command and output"}
        title={copied ? "Copied" : "Copy command and output"}
        onClick={() => void copyText(shellCopyText(item)).then(() => setCopied(true))}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-veil-raised hover:text-foreground focus-visible:opacity-100 focus-visible:outline group-hover/shell:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="max-h-[32rem] overflow-auto scrollbar-thin px-2.5 py-2 pr-8 whitespace-pre-wrap wrap-anywhere select-text">
        {item.author && <span className="font-sans text-faint" data-user-id={item.author.userId}>{item.author.displayName} ran{"\n"}</span>}
        {item.command !== undefined && (
          <span>
            <span className="text-faint select-none">$ </span>
            <span {...commandSection}><LinkedText text={item.command} context={linkContext} /></span>
          </span>
        )}
        {(item.stdout || item.stderr) && (
          <span {...outputSection} className="block text-muted-foreground">
            {item.stdout && <span className="block" data-testid="shell-stdout"><LinkedText text={open ? item.stdout : stdout.shown} context={linkContext} /></span>}
            {item.stderr && <span className="block text-destructive" data-testid="shell-stderr"><LinkedText text={open ? item.stderr : stderr.shown} context={linkContext} /></span>}
          </span>
        )}
        {failed && <span className="block text-destructive" data-testid="shell-exit">exit {item.exitCode}</span>}
      </pre>
      {folded && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="w-full border-t border-hairline px-2.5 py-1 text-left font-sans text-xs text-muted-foreground hover:text-foreground focus-visible:outline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

import { useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closePasteLink, pasteSignInLink, useAccount } from "@/lib/account";

/**
 * Where the browser's sign-in link is pasted when its Open button cannot
 * reach this app: copy that button's link and paste it here to finish the
 * same sign-in. `autoFocus` puts the cursor in the field, as the dialog does.
 */
export function PasteSignInLink({ autoFocus = false, hint = "Button didn't open the app? Right-click it, choose Copy Link, and paste it here." }: { autoFocus?: boolean; hint?: string }) {
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true);
    setProblem(await pasteSignInLink(link));
    setSending(false);
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      data-testid="paste-sign-in-link"
      onSubmit={(event) => {
        event.preventDefault();
        if (link.trim()) void submit();
      }}
    >
      <label htmlFor="sign-in-link" className="text-xs text-muted-foreground">{hint}</label>
      <div className="flex items-center gap-2">
        <input
          id="sign-in-link"
          value={link}
          autoFocus={autoFocus}
          onChange={(event) => { setLink(event.target.value); setProblem(null); }}
          placeholder="terminalx-dev://auth/callback?…"
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-2 font-mono text-[11px] outline-none focus:border-ring"
        />
        <Button type="submit" size="sm" disabled={sending || !link.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : null} Finish sign-in
        </Button>
      </div>
      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
    </form>
  );
}

/**
 * The dev app's sign-in, in one place: as Sign in opens the browser, this
 * asks for the link its Open TerminalX Dev button carries, since that button
 * cannot open a bare dev binary. It goes when the sign-in finishes.
 */
export function SignInLinkDialog() {
  const { pasteLink, status } = useAccount();
  const open = !!pasteLink && status.state === "signing-in";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closePasteLink(); }}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Finish signing in</DialogTitle>
          <DialogDescription>
            Sign in in the browser. When it shows Open TerminalX Dev, right-click that button, choose Copy Link, and paste it here.
          </DialogDescription>
        </DialogHeader>
        <PasteSignInLink autoFocus hint="Sign-in link" />
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Building, CircleAlert, Copy, ExternalLink, Loader2, Lock } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { AgentLogin, BedrockSettings, BedrockTestFailure } from "@/lib/api";

/**
 * Amazon Bedrock as Claude Code's login for an organization's cloud
 * workspaces (PRO-200, design 12.22 and 12.23). Organization-wide, and it
 * takes precedence over members' own Claude Code routes.
 *
 * The page holds only what is not a secret: the sign-in way, the access key
 * ID, the region and the test model. The secret access key or Bedrock API
 * key is asked for by the app in a native secure dialog when "Test and
 * save" is pressed, as every other agent login is. The account service
 * sends Bedrock one short test message with it and stores it only if Bedrock
 * answers; a refusal is shown here with Bedrock's own error.
 */

export const BEDROCK_REGIONS: { id: string; name: string }[] = [
  { id: "us-east-1", name: "N. Virginia" },
  { id: "us-east-2", name: "Ohio" },
  { id: "us-west-2", name: "Oregon" },
  { id: "eu-central-1", name: "Frankfurt" },
  { id: "eu-west-1", name: "Ireland" },
  { id: "eu-west-3", name: "Paris" },
  { id: "eu-north-1", name: "Stockholm" },
  { id: "ap-northeast-1", name: "Tokyo" },
  { id: "ap-southeast-2", name: "Sydney" },
  { id: "ap-south-1", name: "Mumbai" },
];

const BEDROCK_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

const OTHER = "other";

/** The cross-region inference profile Bedrock serves a Claude model under in `region`: `eu.anthropic.claude-opus-5-5`. */
export function bedrockModelId(region: string, model: string): string {
  const geo = region.startsWith("eu-") ? "eu" : region.startsWith("ap-") ? "apac" : "us";
  return `${geo}.anthropic.${model}`;
}

/** What "Copy error" puts on the clipboard. */
export function bedrockErrorText(failure: BedrockTestFailure): string {
  return failure.message ? `${failure.type}: ${failure.message}` : failure.type;
}

/** Bedrock refused the model rather than the keys: the model field says so. */
function modelRefused(failure: BedrockTestFailure | null): boolean {
  return !!failure && ["AccessDeniedException", "ResourceNotFoundException"].includes(failure.type) && /model/i.test(failure.message);
}

const field = "h-8 w-full rounded-md border border-hairline bg-background px-2.5 text-xs disabled:opacity-60";

export function BedrockLoginDialog({ organization, stored, busy, failure, error, onBack, onClose, onSave }: {
  organization: string;
  /** The Claude Code login stored now, which this replaces. */
  stored: AgentLogin | undefined;
  busy: boolean;
  /** Bedrock refused the last test call. */
  failure: BedrockTestFailure | null;
  /** Any other reason the last try failed, in words. */
  error: string | null;
  onBack: () => void;
  onClose: () => void;
  onSave: (settings: BedrockSettings) => void;
}) {
  const [auth, setAuth] = useState<BedrockSettings["auth"]>("aws-keys");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [model, setModel] = useState(BEDROCK_MODELS[0]!.id);
  const [otherModel, setOtherModel] = useState("");
  const modelId = model === OTHER ? otherModel.trim() : bedrockModelId(region, model);
  const modelName = BEDROCK_MODELS.find((candidate) => candidate.id === model)?.name ?? modelId;
  const keyId = accessKeyId.trim().toUpperCase();
  const ready = !!modelId && (auth === "api-key" || /^AKIA[A-Z0-9]{16}$/.test(keyId));
  const refused = modelRefused(failure);
  const replaces = stored && stored.state !== "disconnected";
  const save = () => {
    if (!busy && ready) onSave({ auth, region, model: modelId, ...(auth === "aws-keys" ? { accessKeyId: keyId } : {}) });
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-xl gap-0 p-0" data-testid="bedrock-login">
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <div className="flex items-start gap-3 px-5 pt-5">
            <Button type="button" variant="outline" size="icon-sm" aria-label="Back to Claude Code logins" disabled={busy} onClick={onBack}>
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">Amazon Bedrock for Claude Code</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Claude Code on {organization} machines calls Claude through your AWS account.
              </DialogDescription>
            </div>
          </div>

          <div className="space-y-4 px-5 py-4 text-xs">
            <div className="flex items-center gap-4">
              <span className="text-muted-foreground">Sign in with</span>
              <Segmented aria-label="Sign in with" packed value={auth} disabled={busy} onChange={setAuth}
                options={[{ value: "aws-keys", label: "AWS access keys" }, { value: "api-key", label: "Bedrock API key" }]} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              {auth === "aws-keys" && (
                <label className="flex flex-col gap-1.5">
                  <span>Access key ID</span>
                  <input className={cn(field, "font-mono")} value={accessKeyId} disabled={busy} spellCheck={false} autoComplete="off"
                    placeholder="AKIA…" onChange={(event) => setAccessKeyId(event.target.value)} data-testid="bedrock-access-key-id" />
                </label>
              )}
              <div className={cn("flex flex-col gap-1.5", auth === "api-key" && "col-span-2")}>
                <span>{auth === "aws-keys" ? "Secret access key" : "Bedrock API key"}</span>
                <div className={cn(field, "flex items-center gap-2 text-muted-foreground")} data-testid="bedrock-secret">
                  <Lock className="size-3.5 shrink-0" />
                  <span className="truncate">Entered in a secure window when you test</span>
                </div>
              </div>
              <label className="flex flex-col gap-1.5">
                <span>Region</span>
                <select className={field} value={region} disabled={busy} onChange={(event) => setRegion(event.target.value)} data-testid="bedrock-region">
                  {BEDROCK_REGIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id} · {candidate.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span>Test model</span>
                <select className={cn(field, refused && "border-destructive")} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} data-testid="bedrock-model">
                  {BEDROCK_MODELS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  <option value={OTHER}>Other model ID…</option>
                </select>
              </label>
              {model === OTHER && (
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span>Model or inference profile ID</span>
                  <input className={cn(field, "font-mono")} value={otherModel} disabled={busy} spellCheck={false} autoComplete="off"
                    onChange={(event) => setOtherModel(event.target.value)} data-testid="bedrock-model-other" />
                </label>
              )}
              <p className={cn("col-span-2 -mt-1.5", refused ? "text-destructive" : "text-muted-foreground")} data-testid="bedrock-model-note">
                <code>{modelId || "—"}</code> · {refused ? "Bedrock refused the test call with this model." : "TerminalX sends it one short test message before saving."}
              </p>
            </div>

            <p className="text-muted-foreground">
              {auth === "aws-keys" ? "The key needs " : "The API key needs "}<code>bedrock:InvokeModel</code> and <code>bedrock:InvokeModelWithResponseStream</code>.
              {" "}Keys are stored encrypted for {organization} and never shown again.
              {replaces && ` This replaces the Claude Code login stored now.`}
            </p>

            {failure && (
              <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3" data-testid="bedrock-test-failed">
                <p className="flex items-center gap-2 font-medium"><CircleAlert className="size-3.5 text-destructive" />Test failed · nothing was saved</p>
                <p className="break-words font-mono text-muted-foreground">{bedrockErrorText(failure)}</p>
                <p>
                  {refused
                    ? `Turn on access to ${modelName} in ${region} under Bedrock › Model access in the AWS console, or pick a model this account can use. Then test again.`
                    : "Check the keys, region and model in the AWS console, then test again."}
                </p>
                <div className="flex gap-1.5">
                  <Button type="button" size="xs" variant="outline" onClick={() => void copyText(bedrockErrorText(failure))}><Copy />Copy error</Button>
                  <Button type="button" size="xs" variant="outline"
                    onClick={() => void openUrl(`https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`)}>
                    <ExternalLink />Open AWS console
                  </Button>
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-warning" data-testid="bedrock-error">{error}</p>}
          </div>

          <div className="flex items-center gap-3 border-t border-hairline px-5 py-3">
            <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
              <Building className="size-3.5 shrink-0" />
              <span>For everyone in {organization} · takes precedence over members’ own Claude Code logins</span>
            </p>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy || !ready} data-testid="bedrock-save">
              {busy && <Loader2 className="animate-spin" />}
              {failure ? "Test again" : "Test and save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Disconnect Amazon Bedrock?" (design 12.19): what happens to Claude Code once it is gone. */
export function DisconnectBedrockDialog({ organization, busy, onClose, onConfirm }: {
  organization: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="bedrock-disconnect">
        <DialogTitle className="text-base font-semibold">Disconnect Amazon Bedrock?</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground">
          Claude Code there goes back to each member’s own login. The AWS key is deleted from {organization}.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="animate-spin" />}
            Disconnect Bedrock
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

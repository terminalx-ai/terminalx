import { useEffect, useState } from "react";
import { Building2, ChevronDown, ChevronUp } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePromptTextProps } from "@/lib/autocorrect";
import { usePeople } from "@/lib/cloudPeople";
import { showError } from "@/lib/errorToasts";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { ACTION_PROMPTS, orgLabel, personalPrompt, setCachedPrompts, sharedSetupsApi, useSharedSetupsOrg, type ActionPromptKey, type SharedPrompts } from "@/lib/sharedSetups";
import { RegisteredSetting } from "./settingsRegistry";

type Layer = "personal" | "shared";

/** “Fixture Labs’”, “Acme’s”. */
const whose = (name: string) => (name.endsWith("s") ? `${name}’` : `${name}’s`);

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function savePersonal(action: ActionPromptKey, text: string) {
  if (action === "fixChecks") setPrefs({ fixErrorsInstructions: text.trim() });
  else setPrefs({ actionPrompts: { ...getPrefs().actionPrompts, [action]: text.trim() } });
}

function ago(at: string): string {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function PromptRow({ title, description, saved, held, open, onToggle, chips, footer, readOnly, onSave, saveLabel }: {
  title: string;
  description: string;
  saved: string;
  /** After a conflict: the text this person typed, kept in the editor beside the newer saved version. */
  held?: string | null;
  open: boolean;
  onToggle: () => void;
  chips?: React.ReactNode;
  footer: (draft: string) => React.ReactNode;
  readOnly?: boolean;
  onSave: (text: string) => Promise<void> | void;
  saveLabel: string;
}) {
  const [draft, setDraft] = useState(held ?? saved);
  const [saving, setSaving] = useState(false);
  const textProps = usePromptTextProps();
  useEffect(() => setDraft(held ?? saved), [saved, held]);
  const save = async () => {
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };
  return (
    <li className="border-b border-hairline py-3.5">
      <button type="button" className="flex w-full items-center gap-3 text-left" aria-expanded={open} onClick={onToggle}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
            {title}
            {saved.trim() && <span className="rounded bg-accent/15 px-1.5 text-[10px] font-normal text-accent">Edited</span>}
            {chips}
          </span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
        {open ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
      </button>
      {open && (
        <>
        {held != null && (
          <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <p className="font-medium">Saved by someone else meanwhile</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground" data-testid="newer-prompt">{saved.trim() || "Cleared"}</p>
          </div>
        )}
        <div className="mt-3 overflow-hidden rounded-lg border border-hairline-strong focus-within:border-accent/60">
          <textarea {...textProps} aria-label={title} readOnly={readOnly} maxLength={8000} rows={4}
            className="block w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-relaxed outline-none"
            value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{footer(draft)}</span>
            {!readOnly && <Button size="xs" variant="secondary" disabled={saving || draft.trim() === saved.trim()} onClick={() => void save()}>{saveLabel}</Button>}
          </div>
        </div>
        </>
      )}
    </li>
  );
}

/**
 * Settings › Prompts (PRO-154, designs 10.04 and 10.05): what TerminalX adds
 * to the agent for each action. Your own prompts stay on this computer; an
 * organization's shared ones are set by its owners and admins and sent first.
 */
export function PromptsSettings() {
  const org = useSharedSetupsOrg();
  const [layer, setLayer] = useState<Layer>("personal");
  const [open, setOpen] = useState<ActionPromptKey | null>("general");
  const [shared, setShared] = useState<SharedPrompts | null>(null);
  const [, setVersion] = useState(0);
  // After a conflict, the text each admin typed, kept until they save again or leave.
  const [held, setHeld] = useState<Partial<Record<ActionPromptKey, string>>>({});
  const personName = usePeople(!!org);

  useEffect(() => {
    setShared(null);
    setHeld({});
    if (!org) { setLayer("personal"); return; }
    let cancelled = false;
    sharedSetupsApi.prompts(org.id)
      .then((answer) => { if (!cancelled) { setShared(answer); setCachedPrompts(org.id, answer); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [org]);

  const saveShared = async (action: ActionPromptKey, text: string) => {
    if (!org) return;
    try {
      const { action: _, ...saved } = await sharedSetupsApi.savePrompt(org.id, action, text.trim(), shared?.prompts[action]?.revision ?? 0);
      setShared((before) => {
        const next = { canEdit: before?.canEdit ?? true, prompts: { ...before?.prompts, [action]: saved } };
        setCachedPrompts(org.id, next);
        return next;
      });
      setHeld(({ [action]: _, ...rest }) => rest);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "action_prompt_conflict") {
        // Someone else saved first: their version beside the text typed here, so neither is lost.
        setHeld((before) => ({ ...before, [action]: text }));
        const fresh = await sharedSetupsApi.prompts(org.id).catch(() => null);
        if (fresh) { setShared(fresh); setCachedPrompts(org.id, fresh); }
        showError(fresh
          ? "Someone else changed this prompt while you were editing. Their version is above yours; save again to replace it."
          : "Someone else changed this prompt while you were editing, and their version couldn't be loaded. Your text is kept; try again.",
        undefined, { title: "Not saved", key: "action-prompt-conflict", tone: "warning", copy: false });
        return;
      }
      showError(`Couldn't save the ${ACTION_PROMPTS.find((entry) => entry.key === action)?.title ?? ""} prompt for ${org.name}`, error);
    }
  };

  const tabs: { value: Layer; label: string }[] = [{ value: "personal", label: "Personal" }, ...(org ? [{ value: "shared" as const, label: `${orgLabel(org.name)} · shared` }] : [])];
  const showShared = layer === "shared" && !!org;

  return (
    <RegisteredSetting setting="prompts.actions">
      <section>
        <div role="tablist" aria-label="Prompt layers" className="flex gap-5 border-b border-hairline">
          {tabs.map((tab) => (
            <button key={tab.value} type="button" role="tab" aria-selected={layer === tab.value} onClick={() => setLayer(tab.value)}
              title={tab.label} className={cn("-mb-px max-w-[16rem] truncate border-b-2 px-0.5 pb-2 text-[13px]", layer === tab.value ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {tab.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {showShared
            ? `Added to everyone’s chats in ${org.name}, before their personal prompts. ${shared?.canEdit ? "Owners and admins can edit." : "Only owners and admins can edit."}`
            : org ? `Added to your chats after ${whose(org.name)} shared prompts. Only you see these.` : "Added to your chats. Only you see these."}
        </p>
        <ul className="mt-1">
          {ACTION_PROMPTS.map((action) => {
            const toggle = () => setOpen((current) => (current === action.key ? null : action.key));
            if (showShared) {
              const entry = shared?.prompts[action.key];
              return (
                <PromptRow key={`shared-${action.key}`} title={action.title} description={action.shared} saved={entry?.body ?? ""} held={held[action.key] ?? null}
                  open={open === action.key} onToggle={toggle} readOnly={!shared?.canEdit} saveLabel="Save for everyone"
                  chips={!!entry?.body.trim() && <span className="flex items-center gap-1 rounded bg-veil-strong px-1.5 text-[10px] font-normal text-muted-foreground"><Building2 className="size-3" />Set by {orgLabel(org.name)}</span>}
                  footer={() => entry?.updatedAt ? `Last edited${entry.updatedBy ? ` by ${personName(entry.updatedBy)}` : ""} · ${ago(entry.updatedAt)}` : ""}
                  onSave={(text) => saveShared(action.key, text)} />
              );
            }
            const saved = personalPrompt(action.key);
            return (
              <PromptRow key={`personal-${action.key}`} title={action.title} description={action.personal} saved={saved}
                open={open === action.key} onToggle={toggle} saveLabel="Save"
                footer={(draft) => [org ? `Sent after ${whose(org.name)} shared prompt` : null, `${words(draft)} words`].filter(Boolean).join(" · ")}
                onSave={(text) => { savePersonal(action.key, text); setVersion((value) => value + 1); }} />
            );
          })}
        </ul>
      </section>
    </RegisteredSetting>
  );
}

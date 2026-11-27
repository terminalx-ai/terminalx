import { useState } from "react";
import { Pencil, Trash2 } from "@/icons";
import { SaveSnippetDialog } from "@/components/chat/SaveSnippetDialog";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { showError } from "@/lib/errorToasts";
import { setPrefs, usePrefs, type PromptSnippet } from "@/lib/prefs";
import { getAccount } from "@/lib/account";
import { usePeople, userIdForEmail } from "@/lib/cloudPeople";
import { orgLabel, refreshSharedSetups, sharedSetupsApi, useOrganizationSnippets, useSharedSetupsOrg, type OrganizationSnippet } from "@/lib/sharedSetups";
import { RegisteredSetting } from "./settingsRegistry";

/** The saved prompts offered under `/` in the composer. */
export function SnippetManager() {
  const prefs = usePrefs();
  const [editing, setEditing] = useState<PromptSnippet | "new" | null>(null);
  const remove = (id: string) => setPrefs({ promptSnippets: prefs.promptSnippets.filter((snippet) => snippet.id !== id) });
  // PRO-154: the organization's snippets, and which of the two lists to show.
  const org = useSharedSetupsOrg();
  const orgSnippets = useOrganizationSnippets();
  const [scope, setScope] = useState<"all" | "me" | "org">("all");
  // Only the creator, owners and admins delete a shared snippet (the server's rule), and only after asking.
  usePeople(!!org);
  const me = userIdForEmail(getAccount().status.identity?.email);
  const [confirming, setConfirming] = useState<string | null>(null);
  const removeShared = async (snippet: OrganizationSnippet) => {
    if (!org) return;
    try {
      setConfirming(null);
      await sharedSetupsApi.deleteSnippet(org.id, snippet.id);
      await refreshSharedSetups(org.id);
    } catch (error) {
      showError(`Couldn't delete /${snippet.keyword} from ${org.name}`, error);
    }
  };
  const own = scope === "org" ? [] : prefs.promptSnippets;
  const shared = org && scope !== "me" ? orgSnippets : [];
  return <RegisteredSetting setting="general.snippets">
    <section className="flex min-w-0 flex-col gap-2 py-3 outline-none">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium">Prompt snippets</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">Type / and a name in the composer to insert one. Use {"{{name}}"} for a value to fill in each time.</p>
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setEditing("new")}>New snippet</Button>
      </div>
      {org && (
        <Segmented<"all" | "me" | "org"> aria-label="Snippet scope" packed value={scope} onChange={setScope} options={[
          { value: "all", label: `All ${prefs.promptSnippets.length + orgSnippets.length}` },
          { value: "me", label: `Only me ${prefs.promptSnippets.length}` },
          { value: "org", label: `Everyone at ${orgLabel(org.name)} ${orgSnippets.length}` },
        ]} />
      )}
      {(own.length > 0 || shared.length > 0) && (
        <ul className="flex flex-col">
          {shared.map((snippet) => (
            <li key={snippet.id} className="flex min-w-0 items-center gap-2 py-1">
              <span className="shrink-0 font-mono text-xs">/{snippet.keyword}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{snippet.body.split("\n")[0]}</span>
              {confirming === snippet.id ? <>
                <span className="shrink-0 text-xs">Delete for everyone?</span>
                <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>Cancel</Button>
                <Button variant="destructive" size="xs" onClick={() => void removeShared(snippet)}>Delete</Button>
              </> : <>
                <span className="max-w-[10rem] shrink-0 truncate text-[11px] text-faint" title={org?.name}>{org?.name}</span>
                {(org?.isAdmin || (!!me && snippet.createdBy === me)) && (
                  <Button variant="ghost" size="icon-xs" aria-label={`Delete /${snippet.keyword} from ${org?.name}`} onClick={() => setConfirming(snippet.id)}><Trash2 aria-hidden /></Button>
                )}
              </>}
            </li>
          ))}
          {own.map((snippet) => (
            <li key={snippet.id} className="flex min-w-0 items-center gap-2 py-1">
              <span className="shrink-0 font-mono text-xs">/{snippet.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{snippet.text.split("\n")[0]}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Edit /${snippet.name}`} onClick={() => setEditing(snippet)}><Pencil aria-hidden /></Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Delete /${snippet.name}`} onClick={() => remove(snippet.id)}><Trash2 aria-hidden /></Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <SaveSnippetDialog prompt={editing === "new" ? "" : editing.text} editing={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </section>
  </RegisteredSetting>;
}

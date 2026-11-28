import { useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Keyboard, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, FolderGit2, SearchX } from "lucide-react-native";
import { CloudApiError, MAX_GITHUB_QUERY, MAX_GITHUB_REPOSITORIES, type CloudApi, type CloudGithubApp, type GithubLiveRepositories } from "@mobile/cloud/api";
import { WORDS, chooseableInstallations, githubRefusal, droppedNote, missingNote, openedDraft, setChanged, setChoices, setDropped, setEdited, toggled, type SetDraft } from "@mobile/cloud/github";
import { ChoiceSheet } from "../ChoiceSheet";
import { Notice } from "../Notice";
import { PickRow } from "../PickRow";
import { Button, Card, EmptyState } from "../primitives";
import { RepositoryRow, SkeletonRows } from "../RepositoryRow";
import { TextField } from "../TextField";
import { CountLine, Help, Lede, type RepositoriesPage } from "./parts";

/** How long typing rests before GitHub is searched, through the server. */
export const SEARCH_PAUSE_MS = 350;

/**
 * Choose the repositories the organization's cloud workspaces may clone
 * (25.11), for its owners and admins: what an installation grants, as GitHub
 * lists it now, searched on the server. The set is saved whole, up to 100,
 * and replaces what was saved; a repository hidden by the search stays ticked.
 */
export function ChooseRepositories({ api, orgId, app, installationId: opened, page, onRegisterBack, onBack, onSaved, onReload }: {
  api: Pick<CloudApi, "githubRepositories" | "saveGithubRepositories">;
  orgId: string;
  app: CloudGithubApp;
  /** The installation to open on. */
  installationId: string;
  page: RepositoriesPage;
  onRegisterBack?(handler: (() => void) | null): void;
  onBack(): void;
  /** The set was saved; the server's answer is the organization's new status. */
  onSaved(app: CloudGithubApp): void;
  /** What the organization has may differ from what is shown: read it again. */
  onReload(): void;
}) {
  const installations = chooseableInstallations(app);
  const [installationId, setInstallationId] = useState(opened);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<GithubLiveRepositories | null>(null);
  // The read that last answered; while it is not the one asked for now, the list is loading.
  const [answered, setAnswered] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<SetDraft>({});
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [turn, setTurn] = useState(0);
  // The one read that asks GitHub itself, not the server's list of the last minute: used up by that read, so a later search is not one.
  const fresh = useRef<number | null>(null);
  const asked = `${installationId}\n${query}\n${turn}`;
  const loading = answered !== asked;
  const status = useRef(app);
  useEffect(() => { status.current = app; });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    let current = true;
    const refresh = fresh.current === turn;
    fresh.current = null;
    api.githubRepositories(orgId, installationId, { query, refresh }).then((live) => {
      if (!current) return;
      setList(live);
      setFailure(null);
      setAnswered(asked);
      setDraft((held) => {
        const next = openedDraft(held, status.current, live);
        // Asked of GitHub again, and whole: a tick on a repository it no longer lists is dropped, so the next save can go through.
        if (!refresh || query || live.truncated) return next;
        const granted = new Set(live.repositories.map((repository) => repository.githubRepositoryId));
        return { ...next, [installationId]: (next[installationId] ?? []).filter((githubRepositoryId) => granted.has(githubRepositoryId)) };
      });
    }, (error: unknown) => {
      if (!current) return;
      setFailure(githubRefusal(error));
      setAnswered(asked);
    });
    return () => { current = false; };
  }, [api, orgId, installationId, query, turn, asked]);

  // Counted from the turn as it is then, not as it was when a browser page was opened.
  const again = (refresh: boolean) => setTurn((was) => { fresh.current = refresh ? was + 1 : null; return was + 1; });
  const shown = list && list.installation.id === installationId ? list : null;
  const ticked = draft[installationId] ?? [];
  const total = setChoices(draft, app).length;
  const changed = setChanged(draft, app);
  // Leaving asks only about what the person ticked; what a save drops by itself is not their unsaved work.
  const edited = setEdited(draft, app);
  // Dropped by any save, and not already named under this installation's list as no longer granted.
  const dropped = setDropped(app).filter((repository) => !(repository.installationId === installationId && shown?.missing.some((missing) => missing.githubRepositoryId === repository.githubRepositoryId)));
  const tooMany = total > MAX_GITHUB_REPOSITORIES;
  const manageUrl = shown?.manageUrl ?? installations.find((installation) => installation.id === installationId)?.manageUrl;
  // GitHub's own page for the installation, in the browser over the app; what it grants is read again on the way back.
  const manage = () => { if (manageUrl) void WebBrowser.openBrowserAsync(manageUrl).catch(() => undefined).then(() => { if (alive.current) again(true); }); };

  const save = async () => {
    if (saving || tooMany || !changed) return;
    Keyboard.dismiss();
    setSaving(true);
    setRefusal(null);
    try {
      const saved = await api.saveGithubRepositories(orgId, setChoices(draft, app));
      if (alive.current) onSaved(saved);
    } catch (error) {
      if (!alive.current) return;
      setRefusal(githubRefusal(error, true));
      // Refused, or not known to have been saved: what GitHub grants and what the organization has are read again.
      const invalid = error instanceof CloudApiError && error.code === "cloud_workspace_request_invalid";
      if (!invalid) { onReload(); again(true); }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const leave = () => {
    if (picking) { setPicking(false); return; }
    if (!edited || saving) return onBack();
    Alert.alert("Leave without saving?", "The repositories you chose are not saved for the organization yet.", [
      { text: "Keep choosing", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: onBack },
    ]);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    onRegisterBack?.(() => leaveRef.current());
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      leaveRef.current();
      return true;
    });
    return () => {
      subscription.remove();
      onRegisterBack?.(null);
    };
  }, [onRegisterBack]);

  const account = installations.find((installation) => installation.id === installationId);
  return <>
    {page("Choose repositories", leave, <>
      <Lede small>{WORDS.organizationLede}</Lede>
      {installations.length > 1 ? <Card><PickRow testID="pick-github-account" label="GitHub account" value={account?.accountLogin ?? "Choose"} onPress={() => { Keyboard.dismiss(); setPicking(true); }} first /></Card> : null}
      {refusal ? <Notice testID="save-refusal" tone="danger" text={refusal} /> : null}
      {shown && dropped.length ? <Help testID="organization-dropped">{droppedNote(dropped.map((repository) => repository.fullName))}</Help> : null}
      {failure && !loading ? <Notice testID="list-failed" tone="danger" text={failure} action={{ label: "Try again", onPress: () => again(false) }} />
        : !shown ? <>
          <TextField testID="organization-search" accessibilityLabel="Search repositories" value={typed} onChangeText={setTyped} placeholder="Search repositories" disabled />
          <Card><SkeletonRows testID="organization-loading" count={6} /></Card>
        </>
        : !shown.repositories.length && !query ? <>
          <View testID="grants-none"><EmptyState title="No repositories" detail={WORDS.grantsNone} icon={(color) => <FolderGit2 size={34} color={color} strokeWidth={1.6} />} /></View>
          {manageUrl ? <Button testID="manage-on-github" label="Manage on GitHub" kind="secondary" icon={(color) => <ExternalLink size={16} color={color} />} onPress={manage} /> : null}
        </>
        : <>
          <TextField testID="organization-search" accessibilityLabel="Search repositories" value={typed} onChangeText={setTyped} placeholder="Search repositories" maxLength={MAX_GITHUB_QUERY} autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
          {shown.repositories.length ? <>
            <CountLine testID="organization-count" label="All repositories it grants" count={total ? `${total} chosen` : ""} />
            <Card testID="organization-list">
              {shown.repositories.map((repository, index) => <RepositoryRow key={repository.githubRepositoryId} testID={`grant-${repository.fullName}`} fullName={repository.fullName} isPrivate={repository.private} branch={repository.defaultBranch} first={index === 0}
                on={ticked.includes(repository.githubRepositoryId)} off={saving} onPress={() => setDraft((held) => toggled(held, installationId, repository.githubRepositoryId))} />)}
            </Card>
          </> : <View testID="organization-no-match"><EmptyState title="No repositories match." detail={WORDS.noMatchOrganization} icon={(color) => <SearchX size={34} color={color} strokeWidth={1.6} />} /></View>}
          {shown.truncated ? <Help testID="organization-truncated">{WORDS.truncated}</Help> : null}
          {shown.missing.length ? <>
            <Help testID="organization-missing">{missingNote(shown.missing.map((repository) => repository.fullName))}</Help>
            {manageUrl ? <Button testID="manage-on-github" label="Manage on GitHub" kind="secondary" icon={(color) => <ExternalLink size={16} color={color} />} onPress={manage} /> : null}
          </> : null}
          {tooMany ? <Notice testID="too-many" tone="danger" text={WORDS.tooMany} /> : null}
        </>}
    </>, <Button testID="save-repositories" label={saving ? "Saving…" : total ? `Save · ${total} chosen` : "Save"} disabled={!shown || saving || tooMany || !changed} accessibilityState={{ disabled: !shown || saving || tooMany || !changed, busy: saving }} onPress={() => void save()} />, "For every workspace")}
    {picking ? <ChoiceSheet title="GitHub account" chosen={installationId} choices={installations.map((installation) => ({ id: installation.id, label: installation.accountLogin, ...(installation.state === "suspended" ? { detail: "Suspended on GitHub" } : {}) }))}
      onChoose={(id) => { setTyped(""); setQuery(""); setInstallationId(id); }} onClose={() => setPicking(false)} /> : null}
  </>;
}

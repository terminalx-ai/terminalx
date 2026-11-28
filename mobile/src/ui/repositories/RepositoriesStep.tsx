import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackHandler, FlatList, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight, FolderGit2, GitFork, Globe, Link, Lock, SearchX, Settings2 } from "lucide-react-native";
import type { CloudApi, CloudGithubRepository } from "@mobile/cloud/api";
import { WORDS, chooseableInstallations, launchFull, launchRepository, matchesSearch, repositoriesView, repositoryProblem, sameRepository, suspendedInstallations } from "@mobile/cloud/github";
import { MAX_LAUNCH_REPOSITORIES, REPOSITORY_INVALID, repositoryOf, type LaunchRepository, type PreflightProblems } from "@mobile/cloud/launch";
import { useGithubApp, useGithubConnect, type GithubConnect } from "@mobile/cloud/useGithubConnect";
import { clockText, useRemaining } from "../countdown";
import { Notice } from "../Notice";
import { Button, Card, EmptyState, SectionTitle } from "../primitives";
import { RepositoryName, RepositoryRow, SkeletonRows } from "../RepositoryRow";
import { Spinner } from "../Spinner";
import { TextField } from "../TextField";
import { useTheme } from "../theme";
import { ChooseRepositories } from "./ChooseRepositories";
import { BranchSheet, CountLine, Help, Lede, LinkRow, type RepositoriesPage } from "./parts";

type Connect = ReturnType<typeof useGithubConnect>;
const keyOfOrgRepository = (entry: CloudGithubRepository) => `${entry.installationId}:${entry.githubRepositoryId}`;

/**
 * The launch form's Repositories page (25.11). Before anything is connected
 * it leads with Connect GitHub for an owner or admin, and says who can connect
 * to a member; both keep a typed URL under it. Once the organization has
 * chosen repositories it is a list to pick up to five from, each on its
 * default branch or one that is typed, with a typed URL still one row away.
 *
 * What is ticked here is a working copy: the form gets it when the foot's
 * button is pressed, and Back leaves the form as it was.
 */
export function RepositoriesStep({ api, orgId, organization, repositories, problems, page, onRegisterBack, onUse, onBack, onToken }: {
  api: CloudApi;
  orgId: string;
  /** The organization's name. */
  organization: string;
  /** What the form holds now. */
  repositories: readonly LaunchRepository[];
  /** What the last check before pricing said, about what the form holds. */
  problems: PreflightProblems | null;
  page: RepositoriesPage;
  onRegisterBack?(handler: (() => void) | null): void;
  onUse(repositories: LaunchRepository[]): void;
  onBack(): void;
  /** To where the organization's GitHub token is saved. */
  onToken(): void;
}) {
  const { palette } = useTheme();
  const github = useGithubApp(api, orgId);
  const connect = useGithubConnect(api, orgId, () => void github.reload());
  const [chosen, setChosen] = useState<LaunchRepository[]>(() => [...repositories]);
  const [at, setAt] = useState<"list" | "typed" | { installationId: string }>("list");
  const [search, setSearch] = useState("");
  const [branchOf, setBranchOf] = useState<string | null>(null);
  // The one typed repository the form holds, when that is all it holds: the page's own URL field shows it.
  const only = repositories.length === 1 && repositories[0]!.typed ? repositories[0]! : null;
  const [url, setUrl] = useState(only?.cloneUrl ?? "");
  const [ref, setRef] = useState(only?.ref ?? "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const chooseBackRef = useRef<(() => void) | null>(null);
  const handleBackRef = useRef<() => void>(onBack);
  handleBackRef.current = () => {
    if (typeof at === "object") { (chooseBackRef.current ?? (() => setAt("list")))(); return; }
    if (at === "typed") { setInvalid(null); setAt("list"); return; }
    if (branchOf) { setBranchOf(null); return; }
    onBack();
  };
  useEffect(() => {
    onRegisterBack?.(() => handleBackRef.current());
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (typeof at === "object") return false;
      handleBackRef.current();
      return true;
    });
    return () => {
      subscription.remove();
      onRegisterBack?.(null);
    };
  }, [at, onRegisterBack]);

  const app = github.read.status === "ready" ? github.read.app : null;
  const view = app ? repositoriesView(app) : null;
  const over = connect.state.phase === "ended" ? connect.state : null;
  const full = launchFull(chosen);
  // O(1) membership check per row instead of O(N*M) Array.some (P-79).
  const chosenNames = useMemo(() => new Set(chosen.map((entry) => entry.fullName.toLowerCase())), [chosen]);
  const toggle = useCallback(
    (repository: LaunchRepository) => setChosen((held) => (held.some((entry) => sameRepository(entry, repository)) ? held.filter((entry) => !sameRepository(entry, repository)) : [...held, repository])),
    [],
  );
  const shown = useMemo(
    () => (app ? app.repositories.filter((repository) => matchesSearch(repository.fullName, search)) : []),
    [app, search],
  );
  const renderRepository = useCallback(
    ({ item: entry, index }: { item: CloudGithubRepository; index: number }) => {
      const repository = launchRepository(entry);
      const on = !!repository && chosenNames.has(repository.fullName.toLowerCase());
      const suspended = entry.state === "installation-suspended";
      return <View style={[styles.cardRow, { backgroundColor: palette.card, borderColor: palette.border }, index === 0 && styles.cardTop, index === shown.length - 1 && styles.cardBottom]}>
        <RepositoryRow
          testID={`repository-${entry.fullName}`}
          fullName={entry.fullName}
          isPrivate={entry.private}
          branch={entry.defaultBranch}
          first={index === 0}
          on={on}
          off={suspended || !repository || (!on && full)}
          why={suspended ? null : repositoryProblem(entry)}
          onPress={repository ? () => toggle(repository) : undefined}
        />
      </View>;
    },
    [chosenNames, full, palette.border, palette.card, shown.length, toggle],
  );

  /** What the last check said of a repository, while it is still as it was checked. */
  const said = (repository: LaunchRepository) => {
    const checked = repositories.find((held) => sameRepository(held, repository));
    return checked && checked.ref === repository.ref ? problems?.byRepository?.[repository.fullName.toLowerCase()] ?? null : null;
  };
  const tokenRow = <Card><Pressable testID="add-github-token" accessibilityRole="button" accessibilityLabel={`Add a GitHub token, saved for ${organization}, in Agent logins`} onPress={onToken} style={({ pressed }) => [styles.row, styles.tokenRow, pressed ? { backgroundColor: palette.raised } : null]}>
    <View style={styles.grow}>
      <Text style={[styles.rowLabel, { color: palette.ink }]}>Add a GitHub token</Text>
      <Text style={[styles.detail, { color: palette.muted }]}>{`Saved for ${organization}, in Agent logins`}</Text>
    </View>
    <ChevronRight size={18} color={palette.faint} />
  </Pressable></Card>;

  /** The typed URL as a launch takes it; null, and said under the field, when it is not one. */
  const typedRepository = (): LaunchRepository | null => {
    const parsed = repositoryOf(url);
    if (!parsed) { setInvalid(REPOSITORY_INVALID); return null; }
    // One that the organization's list holds is the picked one, with what is known of it.
    const listed = app?.repositories.find((entry) => entry.state === "accessible" && entry.fullName.toLowerCase() === parsed.fullName.toLowerCase());
    const picked = listed ? launchRepository(listed) : null;
    return picked ? { ...picked, ref: ref.trim() } : { ...parsed, ref: ref.trim(), typed: true };
  };
  const urlFields = (autoFocus: boolean, unchanged: boolean) => <>
    <TextField testID="repository-url" label="GitHub repository URL" value={url} onChangeText={(value) => { setUrl(value); setInvalid(null); }} placeholder="github.com/owner/repository" paste autoFocus={autoFocus} autoCapitalize="none" autoCorrect={false} keyboardType="url"
      error={invalid ?? (unchanged ? problems?.repository : null)} />
    <TextField testID="repository-ref" label="Branch or tag" hint="optional" value={ref} onChangeText={setRef} placeholder="main" autoCapitalize="none" autoCorrect={false} error={unchanged ? problems?.ref : null} />
  </>;

  if (typeof at === "object" && app) {
    return <ChooseRepositories api={api} orgId={orgId} app={app} installationId={at.installationId} page={page}
      onRegisterBack={(handler) => { chooseBackRef.current = handler; }}
      onBack={() => setAt("list")} onReload={() => void github.reload()}
      onSaved={(next) => { github.put(next); connect.dismiss(); setAt("list"); }} />;
  }

  if (at === "typed") {
    const add = () => {
      const typed = typedRepository();
      if (!typed) return;
      const held = chosen.some((entry) => sameRepository(entry, typed));
      if (!held && full) return setInvalid(WORDS.full);
      setChosen(held ? chosen.map((entry) => (sameRepository(entry, typed) ? { ...entry, ref: typed.ref } : entry)) : [...chosen, typed]);
      setUrl(""); setRef(""); setInvalid(null); setAt("list");
    };
    return page("Type a URL", () => { setInvalid(null); setAt("list"); }, <>
      <Lede>{WORDS.typedLede}</Lede>
      {urlFields(true, false)}
      <Help>{WORDS.typedToken}</Help>
    </>, <Button testID="add-repository" label="Add this repository" disabled={!url.trim()} onPress={add} />);
  }

  // Nothing to pick from, and nothing chosen but what was typed: the URL is typed on this page, as it always was.
  const inline = (view === "connect" || view === "ask" || view === "typed") && !over && chosen.length <= 1 && chosen.every((entry) => entry.typed);
  if (inline) {
    const phase = connect.state.phase;
    const unchanged = url === (only?.cloneUrl ?? "") && ref === (only?.ref ?? "");
    const empty = !url.trim();
    const use = () => { const typed = typedRepository(); if (typed) onUse([typed]); };
    return page("Repositories", onBack, <>
      <Lede>{WORDS.lede}</Lede>
      {view === "connect" ? <ConnectCard connect={connect} /> : view === "ask" ? <Notice testID="github-ask" tone="info" text={WORDS.ask} /> : null}
      {view === "typed" ? null : <SectionTitle>Or type a URL</SectionTitle>}
      {urlFields(view !== "connect" && empty, unchanged)}
      {unchanged && problems?.needsGithubToken ? tokenRow : <Help>{WORDS.typedToken}</Help>}
    </>, <>
      <Button testID="use-repository" label="Use this repository" disabled={empty} onPress={use} />
      {phase === "idle" || phase === "starting" ? <Button testID="no-repository" label="Launch without a repository" kind="secondary" onPress={() => onUse([])} /> : null}
    </>);
  }

  const openTyped = () => { setInvalid(null); setAt("typed"); };
  const installations = app ? chooseableInstallations(app) : [];
  const choose = (installationId?: string | null) => { const id = installationId ?? installations[0]?.id; if (id) { Keyboard.dismiss(); setAt({ installationId: id }); } };

  const overBlock = over ? <>
    <Notice testID="github-outcome" tone={over.outcome.tone} text={over.outcome.text} />
    {over.outcome.connected
      ? <><Button testID="choose-repositories" label="Choose repositories" onPress={() => choose(over.installationId)} /><Help>{WORDS.connectedHelp}</Help></>
      : over.outcome.again && app?.configured && app.canManage ? <>
        <Button testID="connect-again" label={over.outcome.again} onPress={connect.connect} />
        <Button testID="connect-installed" label={WORDS.existing} kind="secondary" onPress={connect.connectExisting} />
        <Help>{WORDS.existingHelp}</Help>
      </> : null}
  </> : null;
  const chosenBlock = chosen.length ? <>
    <SectionTitle>Chosen</SectionTitle>
    <Card testID="chosen-repositories">
      {chosen.map((repository, index) => {
        const problem = said(repository);
        const branch = repository.ref || (repository.typed ? null : repository.defaultBranch) || "Default branch";
        const Mark = repository.typed ? Link : repository.private ? Lock : Globe;
        return <Pressable key={repository.cloneUrl} testID={`chosen-${repository.fullName}`} accessibilityRole="button" accessibilityLabel={[`${repository.fullName}, ${repository.typed ? "typed URL, branch or tag" : "branch or tag"}: ${branch}`, problem?.repository, problem?.ref].filter(Boolean).join(". ")}
          onPress={() => { Keyboard.dismiss(); setBranchOf(repository.cloneUrl); }}
          style={({ pressed }) => [styles.row, styles.tall, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, pressed ? { backgroundColor: palette.raised } : null]}>
          <Mark size={16} color={palette.muted} />
          <View style={styles.grow}>
            <RepositoryName fullName={repository.fullName} />
            <Text style={[styles.detail, { color: palette.muted }]}>{repository.typed ? "Typed URL" : "Branch or tag"}</Text>
            {problem?.repository ? <Text style={[styles.detail, { color: palette.danger }]}>{problem.repository}</Text> : null}
            {problem?.ref ? <Text style={[styles.detail, { color: palette.danger }]}>{problem.ref}</Text> : null}
          </View>
          <Text numberOfLines={1} style={[styles.branch, { color: problem?.ref ? palette.danger : palette.muted }]}>{branch}</Text>
          <ChevronRight size={18} color={palette.faint} />
        </Pressable>;
      })}
    </Card>
    {problems?.needsGithubToken && chosen.some((repository) => said(repository)?.repository) ? tokenRow : null}
  </> : null;
  const typedLink = (first: boolean) => <LinkRow testID="type-url" label="Type a repository URL" first={first} off={full} icon={(color) => <Link size={18} color={color} />} onPress={openTyped} />;
  const useFoot = chosen.length
    ? <Button testID="use-repositories" label={chosen.length === 1 ? "Use 1 repository" : `Use ${chosen.length} repositories`} onPress={() => onUse(chosen)} />
    : <Button testID="without-repository" label="Use without a repository" kind="secondary" disabled={github.read.status === "loading"} onPress={() => onUse([])} />;
  const sheet = (() => {
    const repository = chosen.find((entry) => entry.cloneUrl === branchOf);
    if (!repository) return null;
    return <BranchSheet repository={repository} onClose={() => setBranchOf(null)}
      onDone={(next) => { setChosen(chosen.map((entry) => (entry.cloneUrl === repository.cloneUrl ? { ...entry, ref: next } : entry))); setBranchOf(null); }}
      onRemove={() => { setChosen(chosen.filter((entry) => entry.cloneUrl !== repository.cloneUrl)); setBranchOf(null); }} />;
  })();
  const framed = (body: ReactNode, foot: ReactNode, options?: { scroll?: boolean }) => <>{page("Repositories", onBack, body, foot, undefined, options)}{sheet}</>;

  if (github.read.status === "loading") {
    return framed(<>
      <TextField testID="repository-search" accessibilityLabel="Search repositories" value="" onChangeText={() => undefined} placeholder="Search repositories" disabled />
      <CountLine label="Choose up to five" count="" />
      <Card><SkeletonRows testID="repositories-loading" count={5} /></Card>
    </>, useFoot);
  }
  if (!app || !view) {
    return framed(<>
      <Notice testID="repositories-failed" tone="danger" text={WORDS.notLoaded} action={{ label: "Try again", onPress: () => void github.reload() }} />
      {chosenBlock}
      <Card>{typedLink(true)}</Card>
      <Help>{WORDS.typedChecked}</Help>
    </>, useFoot);
  }

  // Just connected, with nothing chosen for workspaces yet: the next step leads, as on the desktop.
  if (view !== "pick" && (over || view === "connect" || view === "ask" || view === "typed")) {
    return framed(<>
      <Lede>{WORDS.lede}</Lede>
      {overBlock ?? (view === "connect" ? <ConnectCard connect={connect} /> : view === "ask" ? <Notice testID="github-ask" tone="info" text={WORDS.ask} /> : null)}
      {chosenBlock}
      <SectionTitle>Or type a URL</SectionTitle>
      <Card>{typedLink(true)}</Card>
    </>, chosen.length ? useFoot : null);
  }

  if (view === "none-admin" || view === "none-member") {
    return framed(<>
      {chosenBlock}
      <View testID={`repositories-${view}`}><EmptyState title="No repositories yet" detail={view === "none-admin" ? WORDS.noneAdmin : WORDS.noneMember} icon={(color) => <FolderGit2 size={34} color={color} strokeWidth={1.6} />} /></View>
      {view === "none-admin" ? <Button testID="choose-repositories" label="Choose repositories" onPress={() => choose()} /> : null}
      <Card>{typedLink(true)}</Card>
    </>, useFoot);
  }

  const pickable = app.repositories.some((repository) => repository.state === "accessible");
  // Every installation was uninstalled on GitHub: an owner or admin can connect again from here.
  const reconnect = app.configured && app.canManage && !installations.length;
  return framed(<FlatList
    testID={shown.length ? "repositories-list" : undefined}
    data={shown}
    keyExtractor={keyOfOrgRepository}
    renderItem={renderRepository}
    keyboardShouldPersistTaps="handled"
    contentContainerStyle={styles.listContent}
    initialNumToRender={20}
    maxToRenderPerBatch={20}
    windowSize={7}
    ListHeaderComponent={<View style={styles.sectionGap}>
      {overBlock}
      {reconnect && !over ? <ConnectCard connect={connect} /> : null}
      {chosenBlock}
      {suspendedInstallations(app).map((installation) => <Notice key={installation.id} testID="installation-suspended" tone="warning" title={installation.title} text={installation.text} />)}
      {chosen.length ? <SectionTitle>All repositories</SectionTitle> : null}
      {pickable ? <>
        <TextField testID="repository-search" accessibilityLabel="Search repositories" value={search} onChangeText={setSearch} placeholder="Search repositories" autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
        <CountLine testID="repositories-count" label="Choose up to five" count={chosen.length ? `${chosen.length} of ${MAX_LAUNCH_REPOSITORIES} chosen` : ""} />
      </> : null}
    </View>}
    ListEmptyComponent={<View testID="repositories-no-match"><EmptyState title="No repositories match." detail={WORDS.noMatchLaunch} icon={(color) => <SearchX size={34} color={color} strokeWidth={1.6} />} /></View>}
    ListFooterComponent={<View style={styles.footerGap}>
      {full ? <Help testID="repositories-full">{WORDS.full}</Help> : null}
      <Card>
        {typedLink(true)}
        {app.canManage && installations.length ? <LinkRow testID="choose-more" label="Choose more for the organization" icon={(color) => <Settings2 size={18} color={color} />} onPress={() => choose()} /> : null}
      </Card>
    </View>}
  />, useFoot, { scroll: false });
}

/** Connect GitHub (25.11), and what it becomes while the browser has the attempt: waiting, then checking. */
function ConnectCard({ connect }: { connect: Connect }) {
  const { palette } = useTheme();
  const state = connect.state;
  const head = (mark: ReactNode, title: string, detail?: string) => <View style={styles.head}>
    {mark}
    <View style={styles.grow}>
      <Text style={[styles.title, { color: palette.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}
    </View>
  </View>;
  if (state.phase === "waiting") return <WaitingCard connect={connect} state={state} head={head} />;
  if (state.phase === "checking") {
    return <Card testID="github-checking"><View style={styles.pad}>
      {head(<Spinner size={20} color={palette.accent} />, "Checking the connection…")}
      <Text style={[styles.text, { color: palette.muted }]}>{WORDS.checking}</Text>
    </View></Card>;
  }
  const starting = state.phase === "starting";
  return <Card testID="github-connect"><View style={styles.pad}>
    {head(<View style={[styles.mark, { backgroundColor: palette.raised, borderColor: palette.border }]}><GitFork size={20} color={palette.ink} /></View>, "Connect GitHub", WORDS.connectDetail)}
    <Text style={[styles.text, { color: palette.muted }]}>{WORDS.connectHow}</Text>
    <Button testID="connect-github" label="Connect GitHub" disabled={starting} accessibilityState={{ disabled: starting, busy: starting }} onPress={connect.connect} />
    <Button testID="connect-installed" label={WORDS.existing} kind="secondary" disabled={starting} onPress={connect.connectExisting} />
    <Text style={[styles.detail, { color: palette.muted }]}>{WORDS.existingHelp}</Text>
  </View></Card>;
}

function WaitingCard({ connect, state, head }: { connect: Connect; state: Extract<GithubConnect, { phase: "waiting" }>; head(mark: ReactNode, title: string): ReactNode }) {
  const { palette } = useTheme();
  // The attempt's end is the server's: counted on the server's clock.
  const left = useRemaining(state.expiresAt, connect.now);
  const busy = state.browser || !!state.canceling;
  return <>
    <Card testID="github-waiting"><View style={styles.pad}>
      {head(<Spinner size={20} color={palette.accent} />, "Waiting for GitHub")}
      <Text style={[styles.text, { color: palette.muted }]}>{state.existing ? WORDS.waitingExisting : WORDS.waiting}</Text>
      <Text testID="github-ends" style={[styles.detail, styles.number, { color: palette.faint }]}>{`This attempt ends in ${clockText(left)}.`}</Text>
      <View style={styles.pair}>
        <Button testID="open-github-again" label="Open GitHub again" kind="secondary" style={styles.grow} disabled={busy} onPress={connect.reopen} />
        <Button testID="cancel-connect" label="Cancel" kind="secondary" disabled={!!state.canceling} onPress={connect.cancel} />
      </View>
    </View></Card>
    {state.problem ? <Notice testID="github-cancel-problem" tone="danger" text={state.problem} /> : null}
  </>;
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  sectionGap: { gap: 12, marginBottom: 12 },
  footerGap: { gap: 12, marginTop: 12 },
  cardRow: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  cardTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  cardBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  tall: { minHeight: 56 },
  tokenRow: { minHeight: 52 },
  rowLabel: { fontSize: 16, lineHeight: 21 },
  grow: { flex: 1, minWidth: 0 },
  detail: { fontSize: 13, lineHeight: 18 },
  branch: { maxWidth: 130, fontSize: 14, lineHeight: 20 },
  pad: { padding: 14, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  mark: { width: 40, height: 40, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  text: { fontSize: 14, lineHeight: 21 },
  number: { fontVariant: ["tabular-nums"] },
  pair: { flexDirection: "row", gap: 8 },
});

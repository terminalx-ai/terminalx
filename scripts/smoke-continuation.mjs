/** Live desktop smoke test, run from the dev webview console:
 * await (await import('/scripts/smoke-continuation.mjs')).runContinuationSmoke({
 *   projectPath: '/absolute/path/to/disposable/git/repo', reportPath: '/tmp/continuation-smoke.json'
 * });
 * Uses installed, signed-in Claude Code and Codex and their normal tab defaults.
 * Creates two source conversations and eight fresh destinations in this checkout.
 * Leaves conversations available for inspection. Never run against real work.
 */
export async function runContinuationSmoke({ projectPath, reportPath, sourceProviders = ['claude', 'codex'], destinationProviders = ['claude', 'codex'] }) {
  const { api, agent, fs } = await import('/src/lib/api.ts');
  const { continuationPrompt, launchContinuation } = await import('/src/lib/continuation.ts');
  const { upsertSession, selectSession, setActiveTab, getSessionStore } = await import('/src/lib/sessions.ts');
  const { getPrefs } = await import('/src/lib/prefs.ts');
  const results = [];
  const report = async () => fs.writeText(reportPath, JSON.stringify(results, null, 2));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, check, label) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (check(value)) return value;
      await sleep(500);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const turnDone = (sid, tid, after = 0) => waitFor(() => agent.loadEvents(sid, tid),
    (events) => events.some((e) => e.seq > after && e.payload.type === 'turn_completed'), `${tid} turn completion`);
  try {
    const providers = await api.listHarnesses();
    assert(['claude', 'codex'].every((id) => providers.some((p) => p.id === id && p.available)), 'Both providers must be installed');
    await api.addProject(projectPath);
    await fs.writeText(`${projectPath}/continuation-uncommitted.txt`, 'SHARED_WORKSPACE_109\n');
    for (const sourceProvider of sourceProviders) {
      const prefs = getPrefs();
      const created = await api.createSession({ projectPath, cwd: projectPath, useWorktree: false,
        title: `Continuation smoke: ${sourceProvider}`, tab: { harness: sourceProvider,
          model: prefs.lastModel[sourceProvider] ?? '', effort: prefs.lastEffort[sourceProvider] ?? null, permissionMode: prefs.lastMode } });
      upsertSession(created); selectSession(created.id);
      const source = created.tabs[0];
      const marker = `EARLY_CONTEXT_109_${sourceProvider}`;
      await agent.send(created.id, source.id, `This is a controlled read-only continuation smoke test. Remember this early context marker: ${marker}. A later fresh conversation will use it. For now reply only HANDOFF_READY and do not use tools or modify anything.`, undefined, true);
      const first = await turnDone(created.id, source.id);
      const after = Math.max(...first.map((e) => e.seq));
      await agent.send(created.id, source.id, 'The task remains unfinished for a fresh continuation: inspect pwd, git status, and continuation-uncommitted.txt in the current workspace. Read the early context marker from this saved conversation. Report the marker, cwd, and uncommitted file content, then stop. Do not change any files. In this source turn only, reply HANDOFF_READY; the fresh continuation should perform the inspection.', undefined, true);
      await turnDone(created.id, source.id, after);
      await sleep(700);
      let context = await agent.prepareContinuation(created.id, source.id);
      assert(context.transcriptPath && context.providerSessionId, 'Source has readable native history and provider identity');
      const before = await fs.readText(context.transcriptPath);
      assert(!before.truncated, 'Smoke fixture must be small enough to compare source bytes');
      const sourceIdentity = context.providerSessionId;
      const seen = new Set([sourceIdentity]);
      for (const provider of destinationProviders) for (const mode of ['focused', 'full']) {
        context = await agent.prepareContinuation(created.id, source.id);
        const count = (await api.listSessions()).find((s) => s.id === created.id).tabs.length;
        const result = await launchContinuation(context, provider, continuationPrompt(context, mode), () => {});
        assert(result.stage === 'delivered', `${sourceProvider} → ${provider} (${mode}): ${result.error}`);
        const events = await turnDone(created.id, result.tab.id);
        const entry = (await api.listSessions()).find((s) => s.id === created.id);
        const destination = entry.tabs.find((t) => t.id === result.tab.id);
        assert(entry.cwd === projectPath && !entry.worktreeName, 'Same cwd, no worktree');
        assert(entry.tabs.length === count + 1, 'Exactly one new tab');
        assert(entry.activeTab === destination.id && getSessionStore().sessions.find((s) => s.id === entry.id).activeTab === destination.id, 'Destination selected');
        assert(destination.providerSessionId && !seen.has(destination.providerSessionId), 'Fresh provider identity');
        seen.add(destination.providerSessionId);
        assert(entry.tabs.find((t) => t.id === source.id).providerSessionId === sourceIdentity, 'Source identity preserved');
        assert(events.filter((e) => e.payload.type === 'user_message').length === 1, 'Exactly one delivered user prompt');
        const reply = events.filter((e) => e.payload.type === 'assistant_text').map((e) => e.payload.text).join('\n');
        assert(reply.includes(marker) && reply.includes('SHARED_WORKSPACE_109'), 'Agent actually read history and uncommitted workspace');
        assert((await fs.readText(context.transcriptPath)).content === before.content, 'Source transcript unchanged');
        results.push({ sourceProvider, provider, mode, status: 'passed', sourceIdentity, destinationIdentity: destination.providerSessionId, cwd: entry.cwd, reply });
        await report();
        // Only smoke destinations are stopped, after their turn has finished.
        await agent.stop(created.id, destination.id);
      }
      await setActiveTab(created.id, source.id);
      const action = await waitFor(() => document.querySelector('button[aria-label="Continue in New Session…"]'), Boolean, 'header action');
      action.click();
      await waitFor(() => document.querySelector('[role="dialog"]'), Boolean, 'continuation dialog');
      assert(document.querySelector('[role="dialog"]').textContent.includes('Full session transcript'), 'Header opens the real dialog');
      const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel');
      cancel.click();
      // Keep source provider sessions intact and idle, as the feature requires.
    }
    results.push({ status: 'complete' });
  } catch (error) {
    results.push({ status: 'failed', error: String(error) });
  }
  await report();
  return results;
}

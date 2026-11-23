import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { defaultExclude } from "vitest/config";

/** PDF.js asks for these by their original filenames; keep them local in both
 * development and packaged builds (no CDN or network access for PDF data). */
function pdfAssets(): Plugin {
  const root = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "pdf-assets",
    async generateBundle() {
      for (const directory of directories) {
        for (const name of await readdir(new URL(`${directory}/`, root))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${directory}/${name}`, source: await readFile(new URL(`${directory}/${name}`, root)) });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs/", async (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec((request.url ?? "").split("?")[0]);
        if (!match) return next();
        try {
          const data = await readFile(new URL(`${match[1]}/${match[2]}`, root));
          response.setHeader("Content-Type", match[2].endsWith(".wasm") ? "application/wasm" : match[2].endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
          response.end(data);
        } catch { next(); }
      });
    },
  };
}

// Every test file, and the ones that run with no DOM: the `node` project. The rest are `dom`,
// in jsdom with src/test/setup.ts, so each file is in exactly one project.
//
// `node` holds every mobile, package and script test, and the src tests below: each is a
// .test.ts that names no DOM API itself (window, document, localStorage, navigator, a DOM
// event or observer, requestAnimationFrame, render or Testing Library), carries no
// `@vitest-environment jsdom` comment, and passed run by path in node with the same tests
// passing as in jsdom. A src test whose imports reach for the DOM stays in `dom` even when its
// own text does not: agentEvents.late, agentEvents.lifecycle, agentEvents.timestamps,
// cloudSetupLayout, cloudWorkClaims, settingsLinks and terminalMemory. A new src test is `dom`
// until it is listed here.
const TEST_FILES = ["src/**/*.test.{ts,tsx}", "mobile/src/**/*.test.ts", "packages/**/*.test.ts", "scripts/*.test.mjs"];
const NODE_SRC_TESTS = [
  "src/components/bots/BotItemAskedBy.test.ts",
  "src/components/changes/CheckLogTab.test.ts",
  "src/components/files/FileTypeIcon.test.ts",
  "src/components/localVm/setup.test.ts",
  "src/components/machines/connectionStatus.test.ts",
  "src/lib/accountRoles.test.ts",
  "src/lib/actionRunner.test.ts",
  "src/lib/agentAccounts.test.ts",
  "src/lib/agentEvents.permissions.test.ts",
  "src/lib/agentHandoff.test.ts",
  "src/lib/agentRoutes.test.ts",
  "src/lib/agentVersion.test.ts",
  "src/lib/api.issues.test.ts",
  "src/lib/approvalDiff.test.ts",
  "src/lib/attachmentRules.test.ts",
  "src/lib/automationSchedule.test.ts",
  "src/lib/automations.test.ts",
  "src/lib/botChats.test.ts",
  "src/lib/botDuties.test.ts",
  "src/lib/botMemory.test.ts",
  "src/lib/browser.watch.test.ts",
  "src/lib/browserInput.test.ts",
  "src/lib/browserPages.test.ts",
  "src/lib/changes.test.ts",
  "src/lib/changesScope.privacy.test.ts",
  "src/lib/chatMedia.test.ts",
  "src/lib/chatSearch.test.ts",
  "src/lib/checkToasts.test.ts",
  "src/lib/checkout.test.ts",
  "src/lib/cleanupRun.test.ts",
  "src/lib/closeUndo.test.ts",
  "src/lib/cloudAgentLabel.test.ts",
  "src/lib/cloudAttention.test.ts",
  "src/lib/cloudCollab.test.ts",
  "src/lib/cloudComposer.test.ts",
  "src/lib/cloudConnections.test.ts",
  "src/lib/cloudCreate.test.ts",
  "src/lib/cloudDashboard.test.ts",
  "src/lib/cloudInbox.test.ts",
  "src/lib/cloudLifecycle.test.ts",
  "src/lib/cloudMirror.test.ts",
  "src/lib/cloudPeople.test.ts",
  "src/lib/cloudPipelines.test.ts",
  "src/lib/cloudPresence.test.ts",
  "src/lib/cloudReadMarkers.test.ts",
  "src/lib/cloudRowState.test.ts",
  "src/lib/cloudSchedules.test.ts",
  "src/lib/cloudSessionTabs.test.ts",
  "src/lib/cloudSessions.archive.test.ts",
  "src/lib/cloudSidebarSections.actions.test.ts",
  "src/lib/cloudSidebarSections.test.ts",
  "src/lib/cloudWorkspaceDetails.test.ts",
  "src/lib/cloudWorkspaceHost.test.ts",
  "src/lib/commandPalette.test.ts",
  "src/lib/continuation.test.ts",
  "src/lib/dashboard.test.ts",
  "src/lib/dataPrivacy.test.ts",
  "src/lib/deleteSessionFlow.test.ts",
  "src/lib/desktopLinks.test.ts",
  "src/lib/environmentInfo.test.ts",
  "src/lib/environmentProposal.test.ts",
  "src/lib/environmentVerification.test.ts",
  "src/lib/errorToasts.test.ts",
  "src/lib/gitSource.test.ts",
  "src/lib/goalCommand.test.ts",
  "src/lib/heldQueue.test.ts",
  "src/lib/hiddenProviders.test.ts",
  "src/lib/issueComments.test.ts",
  "src/lib/issueListFilter.test.ts",
  "src/lib/issueOps.test.ts",
  "src/lib/issueViewer.test.ts",
  "src/lib/issueWork.test.ts",
  "src/lib/localEnvironment.test.ts",
  "src/lib/localMerge.test.ts",
  "src/lib/localSections.test.ts",
  "src/lib/machineAgents.test.ts",
  "src/lib/machineBranchStep.test.ts",
  "src/lib/machineFeatures.test.ts",
  "src/lib/machineNewSession.test.ts",
  "src/lib/machineProjects.test.ts",
  "src/lib/machineResources.test.ts",
  "src/lib/machineSession.test.ts",
  "src/lib/machineWorkspaceHost.test.ts",
  "src/lib/markdownChunks.test.ts",
  "src/lib/messageActivity.test.ts",
  "src/lib/models.test.ts",
  "src/lib/moveChat.test.ts",
  "src/lib/multiOrg.test.ts",
  "src/lib/orchestrateStart.test.ts",
  "src/lib/orchestration.test.ts",
  "src/lib/organizationCompute.test.ts",
  "src/lib/organizationEnvironment.test.ts",
  "src/lib/pairing.test.ts",
  "src/lib/pickers.test.ts",
  "src/lib/prErrors.test.ts",
  "src/lib/projectSearch.test.ts",
  "src/lib/quickChats.test.ts",
  "src/lib/readAloud.test.ts",
  "src/lib/replace.test.ts",
  "src/lib/repositoryActions.test.ts",
  "src/lib/reviewAnchors.test.ts",
  "src/lib/reviewComments.test.ts",
  "src/lib/reviewThreads.test.ts",
  "src/lib/runFamily.test.ts",
  "src/lib/runningLimit.test.ts",
  "src/lib/sessionBackend.test.ts",
  "src/lib/sessionGuest.test.ts",
  "src/lib/sessionNames.test.ts",
  "src/lib/sessionPrs.test.ts",
  "src/lib/settingSources.test.ts",
  "src/lib/settingsDeepLink.test.ts",
  "src/lib/settingsSchemaDescriptions.test.ts",
  "src/lib/settingsSearch.test.ts",
  "src/lib/settingsSections.test.ts",
  "src/lib/sidebarFilter.test.ts",
  "src/lib/sidebarView.test.ts",
  "src/lib/stats.test.ts",
  "src/lib/statsUsageStore.test.ts",
  "src/lib/tabDeepLink.test.ts",
  "src/lib/terminalCounters.test.ts",
  "src/lib/terminalDrop.test.ts",
  "src/lib/terminalInput.test.ts",
  "src/lib/terminalOutputChannel.test.ts",
  "src/lib/terminalPrompt.test.ts",
  "src/lib/terminalSelection.test.ts",
  "src/lib/time.test.ts",
  "src/lib/transcriptCopy.test.ts",
  "src/lib/turnChanges.test.ts",
  "src/lib/turnDivider.test.ts",
  "src/lib/updates.privacy.test.ts",
  "src/lib/viewedChanges.test.ts",
  "src/lib/visibleTab.test.ts",
  "src/lib/workspaceConfig.test.ts",
  "src/lib/workspaceFiles.test.ts",
  "src/lib/worktreeCleanup.test.ts",
  "src/lib/worktreeNames.test.ts",
  "src/styles/inkContrast.test.ts",
  "src/styles/statusContrast.test.ts",
  "src/types/pairing.test.ts",
  "src/types/target.localVm.test.ts",
  "src/types/target.machine.test.ts",
];
const NODE_TESTS = ["mobile/src/**/*.test.ts", "packages/**/*.test.ts", "scripts/*.test.mjs", ...NODE_SRC_TESTS];

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), pdfAssets()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: { format: "es" as const },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.raccoon/**"],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "dom", environment: "jsdom", include: TEST_FILES, exclude: [...defaultExclude, ...NODE_TESTS], setupFiles: ["./src/test/setup.ts"] },
      },
      {
        extends: true,
        test: { name: "node", environment: "node", include: NODE_TESTS },
      },
    ],
  },
}));

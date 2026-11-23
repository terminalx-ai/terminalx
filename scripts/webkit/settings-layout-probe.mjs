// Same fixtures/viewports as settings-navigation.mjs; measure both reported failures.
import { launch, open, serve } from './harness.mjs';
const server = await serve();
const browser = await launch();
const results = [];
try {
  for (const mode of ['light', 'dark']) {
    for (const width of [720, 1280]) {
      const projectCount = width === 720 ? 18 : 2;
      const page = await open(browser, server.url, { cloud: false, localProjects: projectCount, mergedCleanup: true }, { width, height: width === 720 ? 720 : 960 }, {
        extra: `localStorage.setItem('raccoon.mode', ${JSON.stringify(mode)});
          window.__PW_STUB__.answers.merged_cleanup_sweep = { unreadable: [], statuses: [] };
          window.__PW_STUB__.answers.experimental_settings = { nativeCodex: false };
          window.__PW_STUB__.answers.list_projects.projects[0].name = 'A repository with a very long name that should be truncated';`,
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.getByTestId('sidebar-account-row').getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('main', { name: 'Settings', exact: true });
      const nav = settings.getByRole('navigation', { name: 'Settings sections' });
      await nav.getByRole('button', { name: 'A repository with a very long name that should be truncated', exact: true }).click();
      await page.evaluate(() => document.fonts.ready);
      const navigation = await nav.evaluate(element => ({
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        groups: [...element.querySelectorAll('[role="group"]')].map(group => ({
          name: document.getElementById(group.getAttribute('aria-labelledby'))?.textContent,
          top: group.getBoundingClientRect().top, bottom: group.getBoundingClientRect().bottom,
        })),
      }));
      await nav.getByRole('button', { name: 'Agents', exact: true }).click();
      await settings.getByRole('heading', { name: 'Agents', exact: true, level: 2 }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const agents = await settings.locator('section[aria-labelledby="settings-section-title"]').evaluate(column => {
        const box = column.getBoundingClientRect();
        const bounds = element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        };
        return {
          clientWidth: column.clientWidth, scrollWidth: column.scrollWidth, ...bounds(column),
          offenders: [...column.querySelectorAll('*')].filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width && (rect.right > box.right + 1 || rect.left < box.left - 1);
          }).map(element => ({
            tag: element.tagName, setting: element.closest('[data-setting-id]')?.getAttribute('data-setting-id'),
            text: element.textContent?.slice(0, 140), ...bounds(element),
          })),
        };
      });
      results.push({ mode, width, navigation, agents, errors });
      await page.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); server.close(); }

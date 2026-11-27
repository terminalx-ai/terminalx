#!/usr/bin/env node
// PRO-596: an organization's Billing page in the desktop's WebKit engine. The
// plan card's columns, the seats bar and the payment row's button must stay
// inside their boxes without overlapping at the normal and narrow widths, and
// Manage payment must ask the app for the Polar portal.
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1, orgName: "Acme Industrial Holdings With A Long Organization Name" }, { width, height: 900 }, {
      locale: "en-US",
      extra: `(() => {
        const stub = window.__PW_STUB__;
        stub.answers.account_status.phase2Readiness = { "org-a": ["organization.desktop-billing.v1"] };
        window.__PORTAL__ = [];
        stub.answers.organization_billing = () => ({
          plan: "teams", billedTo: "organization",
          seats: { used: 3, limit: 5 },
          seatPrice: { currency: "USD", unitAmountMinor: 2000, interval: "month" },
          nextCharge: { date: "2026-12-01T12:00:00.000Z", amountMinor: 6000, currency: "USD" },
          payer: "A Payer With A Rather Long Display Name For Wrapping", canManageBilling: true,
        });
        stub.answers.organization_billing_portal = ({ orgId, view }) => {
          window.__PORTAL__.push([orgId, view]);
          return "https://polar.sh/acme/portal";
        };
      })();`,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account", exact: true }).click();
    await page.getByTestId("account-organization-settings").getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("group", { name: /settings$/ }).getByRole("button", { name: "Billing", exact: true }).click();
    const root = page.getByTestId("organization-billing");
    await root.waitFor();
    const layout = await root.evaluate((billing) => {
      const main = billing.closest('[role="main"]') ?? document.body;
      const box = (element) => element.getBoundingClientRect();
      const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
      const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const card = billing.querySelector('section[aria-label="Plan"]');
      const columns = [...card.querySelectorAll("dl > div")].map(box);
      const buttons = [...billing.querySelectorAll("button")];
      const payment = buttons.find((button) => button.textContent.includes("Manage payment"));
      const paymentText = payment.parentElement.querySelector("div");
      return {
        noPageOverflow: main.scrollWidth <= main.clientWidth + 1,
        columnsInside: columns.every((column) => inside(column, box(card))),
        columnsApart: columns.every((a, i) => columns.every((b, j) => i === j || !overlap(a, b))),
        paymentApart: !overlap(box(payment), box(paymentText)) && inside(box(payment), box(billing)),
        buttonOneLine: box(payment).height < 40,
        columns: columns.length,
      };
    });
    await root.screenshot({ path: `/tmp/pro-596-billing-${width}.png` });
    await page.getByRole("button", { name: "Manage payment" }).click();
    await page.waitForFunction(() => window.__PORTAL__.length > 0);
    const portal = await page.evaluate(() => window.__PORTAL__);
    failed += report(`billing page at ${width}px`, {
      "the page does not widen the Settings column": layout.noPageOverflow,
      "seats, next charge and payer each have a column": layout.columns === 3,
      "the columns stay inside the plan card": layout.columnsInside,
      "the columns do not overlap": layout.columnsApart,
      "the payment button stays clear of its text": layout.paymentApart,
      "the payment button stays on one line": layout.buttonOneLine,
      "Manage payment asks for this organization's portal": portal.length === 1 && portal[0][0] === "org-a" && portal[0][1] === "organization",
    }, { layout, portal });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);

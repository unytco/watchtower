import { test, expect } from "@playwright/test";

const DNA_B64 = "dna-hC0k-test";

test("home renders DNA list and fleet strip, click-through opens DNA detail", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/observers") {
      return route.fulfill({
        json: {
          observers: [
            {
              observer_id: "heart-always-online-2",
              last_seen_iso: new Date().toISOString(),
              last_collection_ms: 120,
              uptime_s: 3600,
              schema_version: 1,
              n_errors: 0,
              is_healthy: 1,
              binary_version: "test",
            },
          ],
        },
      });
    }

    if (path === "/api/dnas") {
      return route.fulfill({
        json: {
          dnas: [
            {
              dna_b64: DNA_B64,
              dna_tag: "unyt",
              observer_count: 1,
              agent_count: 3,
              total_actions: 1234,
              warrant_count: 0,
              first_seen_iso: new Date(Date.now() - 3600_000).toISOString(),
              last_activity_iso: new Date().toISOString(),
            },
          ],
        },
      });
    }

    if (path === `/api/dnas/${DNA_B64}/summary`) {
      return route.fulfill({
        json: {
          dna_b64: DNA_B64,
          dna_tag: "unyt",
          agents: 3,
          total_actions: 1234,
          agents_closed: 2,
          agents_opened: 1,
          warrants: 0,
          observers: 1,
          last_activity_iso: new Date().toISOString(),
        },
      });
    }

    if (path === `/api/dnas/${DNA_B64}/agents`) {
      return route.fulfill({
        json: {
          per_observer: false,
          agents: [
            {
              agent_b64: "agent-A",
              agent_tag: null,
              action_count: 500,
              observer_count: 1,
              first_seen_iso: new Date().toISOString(),
              last_seen_iso: new Date().toISOString(),
              warrants_issued: 0,
              warrants_against: 0,
              chain_closed: 1,
              opening_summary_present: 0,
            },
          ],
        },
      });
    }

    if (path.startsWith("/api/metrics") || path === `/api/warrants`) {
      return route.fulfill({ json: { metrics: [], warrants: [] } });
    }

    return route.fulfill({ json: {} });
  });

  await page.goto("/");

  await expect(page.getByRole("link", { name: "watchtower", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "DNAs", exact: true })).toBeVisible();
  await expect(page.getByText("Fleet")).toBeVisible();
  await expect(page.getByText("heart-always-online-2")).toBeVisible();

  await expect(page.getByText("unyt").first()).toBeVisible();
  await expect(page.getByText("1,234")).toBeVisible();

  await page.getByText("unyt").first().click();

  await expect(page).toHaveURL(new RegExp(`/dnas/${encodeURIComponent(DNA_B64)}$`));
  await expect(page.getByText("Total actions")).toBeVisible();
  // Migration counters render on the DNA's existing detail view.
  await expect(page.getByText("Agents closed")).toBeVisible();
  await expect(page.getByText("Agents opened")).toBeVisible();

  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByText("agent-A")).toBeVisible();
  // The per-agent migration flags render as their own columns.
  await expect(page.getByRole("columnheader", { name: "Closed" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Opened" })).toBeVisible();
});

test("DNA with no migrations renders the counters at zero", async ({ page }) => {
  // Outside a migration window the summary reports zero closed/opened; the
  // tiles must still render (as 0), not blank or error.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/dnas/${DNA_B64}/summary`) {
      return route.fulfill({
        json: {
          dna_b64: DNA_B64,
          dna_tag: "unyt",
          agents: 0,
          total_actions: 0,
          agents_closed: 0,
          agents_opened: 0,
          warrants: 0,
          observers: 1,
          last_activity_iso: new Date().toISOString(),
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto(`/dnas/${encodeURIComponent(DNA_B64)}`);

  // Scope to the migration tiles by their label-derived test id, so the
  // assertion can't be satisfied by another tile (e.g. Total actions) that
  // also reads 0 — a blank / NaN regression in these tiles would now fail.
  await expect(page.getByText("Agents closed")).toBeVisible();
  await expect(page.getByText("Agents opened")).toBeVisible();
  await expect(page.getByTestId("tile-agents-closed")).toHaveText("0");
  await expect(page.getByTestId("tile-agents-opened")).toHaveText("0");
});

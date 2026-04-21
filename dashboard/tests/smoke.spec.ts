import { test, expect } from "@playwright/test";

const DNA_B64 = "dna-hC0k-test";

test("home renders DNA list and fleet strip, click-through opens DNA detail", async ({
  page,
}) => {
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

  await expect(page.getByText("watchtower")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "DNAs", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Fleet")).toBeVisible();
  await expect(page.getByText("heart-always-online-2")).toBeVisible();

  await expect(page.getByText("unyt").first()).toBeVisible();
  await expect(page.getByText("1,234")).toBeVisible();

  await page.getByText("unyt").first().click();

  await expect(page).toHaveURL(new RegExp(`/dnas/${encodeURIComponent(DNA_B64)}$`));
  await expect(page.getByText("Total actions")).toBeVisible();
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByText("agent-A")).toBeVisible();
});

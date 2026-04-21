import { test, expect } from "@playwright/test";

// Minimal smoke test. Assumes the Worker is running at /api (vite proxy).
// If the backend is unreachable the page still has to render with empty tables.
test("overview renders headings and observer switcher", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/api/observers")) {
      return route.fulfill({ json: { observers: [] } });
    }
    if (url.startsWith("http") && url.includes("/api/summary")) {
      return route.fulfill({ json: { agents: 0, warrants: 0, dnas: 0 } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByText("unyt · watchtower")).toBeVisible();
  await expect(page.getByText("Agents", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Warrants", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("DNAs", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("All observers")).toBeVisible();
});

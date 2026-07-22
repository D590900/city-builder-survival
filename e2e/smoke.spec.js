// Smoke tests for Last Refuge, run by Playwright against the production
// build (see playwright.config.js — `vite preview` on port 4173, same base
// path as GitHub Pages). They boot a deterministic map (?seed=42), check
// the HUD and the build menu, then exercise the dawn autosave and the
// save restore across a reload. Selectors rely on the existing DOM
// classes (see src/ui/hud.js, src/ui/buildmenu.js, src/ui/screens.js); the
// game also exposes window.__game.state for headless checks (src/main.js).

import { test, expect } from '@playwright/test';

const BASE = '/city-builder-survival/';
const SAVE_KEY = 'cbs-save';
// HUD resource labels, in DOM order (src/ui/hud.js BALANCE_RESOURCES).
const RESOURCE_LABELS = ['Food', 'Water', 'Wood', 'Metal', 'Energy', 'Fuel'];

// Collects console errors and uncaught page errors for the whole test;
// assert on the returned array at the end so late errors still surface.
function watchConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chromium logs the (missing) favicon request as a console error;
    // the game ships no favicon, so that one is noise.
    if (msg.location()?.url?.includes('favicon')) return;
    errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

// Boots a fresh deterministic game, skipping the title screen, and waits
// for the HUD to come up (assets have loaded and the first frame ran).
async function bootGame(page, errors) {
  await page.goto(`${BASE}?autostart=1&seed=42`);
  await expect(page.locator('.hud-day')).toHaveText('Day 1', { timeout: 30_000 });
  await expect(page.locator('#game')).toBeVisible();
  expect(errors).toEqual([]);
}

test('boots to the HUD with day 1, resources and a working build menu', async ({ page }) => {
  const errors = watchConsoleErrors(page);
  await bootGame(page, errors);

  // Pause the simulation: every assertion below is then time-independent
  // (day 1 lasts 90 s at 1x, which slow headless runs could otherwise exceed).
  await page.getByTitle('Pause').click();
  await expect(page.getByTitle('Pause')).toHaveClass(/active/);

  // Top bar: the six resources. The labels are not printed next to the
  // amounts; hovering a resource opens the daily-balance breakdown whose
  // title carries "<icon> <label> — daily balance".
  const resources = page.locator('.hud-resources .hud-res');
  await expect(resources).toHaveCount(RESOURCE_LABELS.length);
  for (const [i, label] of RESOURCE_LABELS.entries()) {
    await resources.nth(i).hover();
    await expect(page.locator('.hud-balance-title')).toContainText(label);
  }

  // Build menu: one tab per category, the Housing tab active by default,
  // and its building buttons visible with name and cost.
  await expect(page.locator('.build-tab')).toHaveCount(6);
  await expect(page.locator('.build-tab').first()).toHaveClass(/active/);
  const visibleBuildings = page.locator('.build-list .build-btn:visible');
  await expect(visibleBuildings).toHaveCount(3); // Tent, Shack, House

  // Clicking a building selects it: the button is highlighted while the
  // placement ghost is up; Cancel (side button) clears the selection.
  const tent = page
    .locator('.build-list .build-btn')
    .filter({ has: page.locator('.build-btn-name:text-is("Tent")') });
  await tent.click();
  await expect(tent).toHaveClass(/active/);
  await page.locator('.build-btn--side').filter({ hasText: 'Cancel' }).click();
  await expect(tent).not.toHaveClass(/active/);

  // The run autosaves at the start of day 1 (src/main.js saveGame()).
  const save = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    SAVE_KEY
  );
  expect(save?.version).toBe(4);
  expect(save?.seed).toBe(42);
  expect(save?.day).toBe(1);

  expect(errors).toEqual([]);
});

test('autosaves at dawn and restores the run after a reload', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsoleErrors(page);
  await bootGame(page, errors);

  // Fast-forward to the first dawn: day (90 s) + night (60 s) at 3x speed
  // is ~50 s of wall time; the timeout also covers slow software rendering
  // (game time lags wall time below 10 fps).
  await page.getByTitle('Speed 3x').click();
  await expect(page.getByTitle('Speed 3x')).toHaveClass(/active/);
  await page.waitForFunction(() => window.__game?.state?.day >= 2, null, {
    timeout: 150_000,
  });
  await expect(page.locator('.hud-day')).toHaveText('Day 2');

  // startDay() saves synchronously before the frame we just observed.
  const save = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    SAVE_KEY
  );
  expect(save?.day).toBe(2);

  // Reload without ?autostart: the title screen shows and the save loads
  // (autostart would force a fresh game instead). The restored run starts
  // at the beginning of the saved day, so the counter reads exactly Day 2.
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Start game' }).click();
  await expect(page.locator('.hud-day')).toHaveText('Day 2', { timeout: 30_000 });

  expect(errors).toEqual([]);
});

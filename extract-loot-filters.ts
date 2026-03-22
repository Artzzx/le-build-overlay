/**
 * extract-loot-filters.ts — Last Epoch Filter Engine Pipeline
 *
 * Navigates to each maxroll.gg Last Epoch planner URL, opens the Loot Filter
 * modal, iterates through all 5 strictness levels, generates the filter XML
 * for each level, and saves the output.
 *
 * Output: data/sources/filters/{buildSlug}_{strictness}.xml
 *
 * CLI:
 *   npx tsx scripts/data/maxroll/extract-loot-filters.ts
 *   npx tsx scripts/data/maxroll/extract-loot-filters.ts --only <build-name>
 *   npx tsx scripts/data/maxroll/extract-loot-filters.ts --inspect <build-name>
 *
 * --inspect mode: opens the Loot Filter modal and saves HTML + screenshot to
 *   scripts/data/maxroll/inspect/ so you can examine the DOM and update selectors.
 */

import { chromium, type Page } from 'playwright';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../');

const PLANNER_URLS_PATH = path.join(PROJECT_ROOT, 'scripts/data/maxroll/planner-urls.json');
const INSPECT_DIR = path.join(PROJECT_ROOT, 'scripts/data/maxroll/inspect');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data/sources/filters');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Strictness levels in slider order (index 0 = most permissive, 4 = most strict).
// These become the filename suffix: {buildSlug}_{strictness}.xml
// Names match the maxroll.gg UI labels (lowercased + underscored).
const STRICTNESS_LEVELS = [
  'regular',
  'strict',
  'very_strict',
  'uber_strict',
  'giga_strict',
] as const;

type Strictness = (typeof STRICTNESS_LEVELS)[number];

// Exact UI labels shown in the Loot Filter modal on maxroll.gg.
// Must match character-for-character — used with getByText({ exact: true }).
const STRICTNESS_DISPLAY: Record<Strictness, string> = {
  regular: 'Regular',
  strict: 'Strict',
  very_strict: 'Very Strict',
  uber_strict: 'Uber Strict',
  giga_strict: 'GIGA Strict',
};

const DELAY_BETWEEN_BUILDS_MS = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlannerUrls {
  [buildName: string]: string;
}

interface SkippedEntry {
  buildName: string;
  strictness: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Clipboard intercept
//
// Must be injected via addInitScript() before page.goto() so it patches the
// clipboard API before the site's JS initialises.
// ---------------------------------------------------------------------------

async function injectClipboardIntercept(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__capturedClipboard = null;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__capturedClipboard = text;
        return orig(text);
      };
    }
  });
}

async function resetClipboardCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__capturedClipboard = null;
  });
}

async function getClipboardCapture(page: Page, timeoutMs = 5000): Promise<string | null> {
  // Wait for the site to write to clipboard at least once, then settle.
  try {
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__capturedClipboard !== null,
      { timeout: timeoutMs },
    );
  } catch {
    // Intercept never fired — fall through and try readText()
  }
  await page.waitForTimeout(600);

  try {
    return await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await page.evaluate(() => (window as any).__capturedClipboard as string | null);
  }
}

// ---------------------------------------------------------------------------
// Consent overlay
// ---------------------------------------------------------------------------

async function dismissConsent(page: Page): Promise<void> {
  try {
    const btn = page.locator(
      'button#onetrust-accept-btn-handler, button:has-text("I Consent"), button:has-text("Accept All")',
    );
    await btn.first().click({ timeout: 5000 });
    await page.waitForTimeout(800);
  } catch {
    // No consent dialog present
  }
}

// ---------------------------------------------------------------------------
// Planner ready check
// ---------------------------------------------------------------------------

async function waitForPlannerReady(page: Page): Promise<void> {
  // The phase dropdown renders once React has fully mounted
  await page.waitForSelector('div.equipment_SelectValue__2wQLH', { timeout: 30000 });
  await page.waitForTimeout(1000);
}

// ---------------------------------------------------------------------------
// Loot Filter modal
// ---------------------------------------------------------------------------

async function openLootFilterModal(page: Page): Promise<void> {
  const btn = page.locator('button', { hasText: 'Loot Filter' });
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
  await page.waitForTimeout(1000);
}

async function dismissLootFilterModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // If the modal is still open, click outside it
  const stillOpen = await page
    .locator('button:visible', { hasText: 'Generate' })
    .isVisible()
    .catch(() => false);
  if (stillOpen) {
    await page.mouse.click(20, 20);
    await page.waitForTimeout(400);
  }

  // Wait for the Generate button to disappear (= modal fully closed)
  await page
    .waitForSelector('button:has-text("Generate")', { state: 'hidden', timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Strictness selection
//
// The modal uses a CUSTOM React slider — NOT a native <input type="range">.
// DOM structure (from --inspect capture):
//
//   div.lep-filter-generator-slider
//     div._Slider_*                  ← React component root
//       div._Slider__track_*         ← CLICK HERE at the right x-position
//         span._Slider__thumb_*      ← visual thumb (style="left: 0%;" = Regular)
//
//   div.lep-filter-generator-slider-names
//     <div>Regular</div>             ← DECORATIVE ONLY — no click handler
//     <div>Strict</div>              ← DECORATIVE ONLY — no click handler
//     ...
//
// Clicking the label <div>s does nothing to React state (confirmed via testing).
// The correct interaction is a mouse click on the track at the correct x-offset:
//   index 0 = 0%  (Regular)
//   index 1 = 25% (Strict)
//   index 2 = 50% (Very Strict)
//   index 3 = 75% (Uber Strict)
//   index 4 = 100% (GIGA Strict)
//
// We scope to .lep-filter-generator-slider (stable BEM class) then find the
// track by [class*="Slider__track"] to survive CSS-module hash rotation.
// ---------------------------------------------------------------------------

async function setStrictness(page: Page, level: Strictness, index: number): Promise<boolean> {
  // Find the track element scoped to the loot filter slider (stable class)
  const track = page
    .locator('.lep-filter-generator-slider [class*="Slider__track"]')
    .first();

  if (await track.isVisible().catch(() => false)) {
    const box = await track.boundingBox();
    if (box) {
      // Map index 0-4 to 0–100% of the track width
      const xFraction = index / (STRICTNESS_LEVELS.length - 1);
      // Stay 2 px inside each edge to avoid missing the element at extremes
      const x = box.x + Math.max(2, Math.min(box.width - 2, box.width * xFraction));
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      await page.waitForTimeout(400);

      // Verify: description text should update to reflect the selected level
      const desc = await page
        .locator('.lep-filter-generator-slider-description')
        .textContent()
        .catch(() => '');
      console.log(`    → slider: ${desc?.slice(0, 70) ?? '(no description)'}`);
      return true;
    }
  }

  // Fallback: if the UI has changed to a tab/button layout, try clicking the
  // nth child of the slider-names container directly.
  const nameDivs = page.locator('.lep-filter-generator-slider-names > div');
  if ((await nameDivs.count().catch(() => 0)) === STRICTNESS_LEVELS.length) {
    await nameDivs.nth(index).click();
    await page.waitForTimeout(400);
    return true;
  }

  return false; // could not find the slider control
}

// ---------------------------------------------------------------------------
// Filter XML extraction
//
// After clicking Generate, the XML output appears either in a textarea or is
// written to the clipboard. We check both.
// ---------------------------------------------------------------------------

async function extractFilterXml(page: Page): Promise<string | null> {
  // Strategy 1: textarea that contains XML
  const textareas = page.locator('textarea');
  const count = await textareas.count();
  for (let i = 0; i < count; i++) {
    const val = await textareas.nth(i).inputValue().catch(() => '');
    if (val.trim().startsWith('<') || val.includes('ItemFilter') || val.includes('LootFilter') || val.includes('RuleBlock')) {
      return val.trim();
    }
  }

  // Strategy 2: clipboard (site may copy XML directly)
  try {
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip && (clip.trim().startsWith('<') || clip.includes('Filter'))) {
      return clip.trim();
    }
  } catch {
    // no clipboard access
  }

  // Strategy 3: captured intercept value
  const intercepted = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__capturedClipboard as string | null,
  );
  if (intercepted && intercepted.trim().startsWith('<')) {
    return intercepted.trim();
  }

  // Strategy 4: <pre> or <code> block containing XML
  const preBlocks = page.locator('pre, code');
  const preCount = await preBlocks.count();
  for (let i = 0; i < preCount; i++) {
    const text = await preBlocks.nth(i).textContent().catch(() => '');
    if (text && (text.trim().startsWith('<') || text.includes('ItemFilter'))) {
      return text.trim();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Per-build extraction
// ---------------------------------------------------------------------------

async function extractFiltersForBuild(
  page: Page,
  buildName: string,
  url: string,
  skipped: SkippedEntry[],
  verbose: boolean,
): Promise<number> {
  console.log(`\n[${buildName}]`);
  console.log(`  URL: ${url}`);

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000); // React hydration settle

  await dismissConsent(page);

  try {
    await waitForPlannerReady(page);
  } catch {
    console.warn(`  [WARN] Planner did not fully load — proceeding`);
  }

  // Ensure no leftover modal from a previous run
  const generateVisible = await page
    .locator('button:visible', { hasText: 'Generate' })
    .isVisible()
    .catch(() => false);
  if (generateVisible) {
    await dismissLootFilterModal(page);
  }

  let saved = 0;

  for (let i = 0; i < STRICTNESS_LEVELS.length; i++) {
    const strictness = STRICTNESS_LEVELS[i];
    const outFile = path.join(OUTPUT_DIR, `${slugify(buildName)}_${strictness}.xml`);

    console.log(`  [${i + 1}/${STRICTNESS_LEVELS.length}] ${STRICTNESS_DISPLAY[strictness]}…`);

    try {
      await resetClipboardCapture(page);
      await openLootFilterModal(page);

      const setOk = await setStrictness(page, strictness, i);
      if (!setOk) {
        console.warn(`    [WARN] Strictness control not found for "${strictness}" — using modal default`);
      }

      // Click Generate
      const generateBtn = page.locator('button', { hasText: 'Generate' });
      await generateBtn.first().waitFor({ state: 'visible', timeout: 8000 });
      await generateBtn.first().click();
      await page.waitForTimeout(1200);

      const xml = await extractFilterXml(page);

      if (!xml) {
        skipped.push({ buildName, strictness, reason: 'No XML content found after Generate' });
        console.warn(`    [SKIP] No XML content — check --inspect output`);
      } else {
        await writeFile(outFile, xml, 'utf-8');
        console.log(`    ✓ Saved ${path.basename(outFile)} (${xml.length} bytes)`);
        if (verbose) console.log(`    XML preview: ${xml.slice(0, 120)}…`);
        saved++;
      }

      await dismissLootFilterModal(page);

    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ buildName, strictness, reason });
      console.warn(`    [ERROR] ${reason}`);
      await dismissLootFilterModal(page).catch(() => {});
    }

    await page.waitForTimeout(400);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Inspect mode
//
// Opens the Loot Filter modal, saves HTML + screenshot so you can identify
// the correct selectors for the strictness control and output area.
// ---------------------------------------------------------------------------

async function runInspectMode(page: Page, buildName: string, url: string): Promise<void> {
  await mkdir(INSPECT_DIR, { recursive: true });
  const slug = slugify(buildName);

  console.log(`[inspect] Build: ${buildName}`);
  console.log(`[inspect] URL:   ${url}`);
  console.log('[inspect] Navigating…');

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);
  await dismissConsent(page);

  try {
    await waitForPlannerReady(page);
    console.log('[inspect] Planner ready');
  } catch {
    console.warn('[inspect] Planner not fully loaded — continuing anyway');
  }

  // Open the Loot Filter modal
  try {
    await openLootFilterModal(page);
    console.log('[inspect] Loot Filter modal opened');
  } catch (err) {
    console.warn('[inspect] Could not open Loot Filter modal:', err instanceof Error ? err.message : err);
  }

  const htmlPath = path.join(INSPECT_DIR, `${slug}-loot-filter.html`);
  const pngPath = path.join(INSPECT_DIR, `${slug}-loot-filter.png`);

  await writeFile(htmlPath, await page.content(), 'utf-8');
  await page.screenshot({ path: pngPath, fullPage: false }); // viewport screenshot — modal visible
  await page.screenshot({ path: pngPath.replace('.png', '-full.png'), fullPage: true });

  console.log(`\n[inspect] Saved HTML:       ${path.relative(PROJECT_ROOT, htmlPath)}`);
  console.log(`[inspect] Saved screenshot: ${path.relative(PROJECT_ROOT, pngPath)}`);
  // Also log what getByText finds for each level to aid selector debugging
  console.log('\n[inspect] getByText exact-match results for each strictness label:');
  for (const [key, label] of Object.entries(STRICTNESS_DISPLAY)) {
    const matches = page.getByText(label, { exact: true });
    const n = await matches.count().catch(() => 0);
    const details: string[] = [];
    for (let i = 0; i < n; i++) {
      const el = matches.nth(i);
      const vis = await el.isVisible().catch(() => false);
      const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '?');
      const cls = await el.evaluate((e: Element) => e.className.slice(0, 60)).catch(() => '');
      details.push(`${tag}${vis ? '' : '(hidden)'}${cls ? ` [${cls}]` : ''}`);
    }
    console.log(`  "${label}" (${key}): ${n} match(es) — ${details.join(', ') || 'none'}`);
  }
  console.log('\n[inspect] If matches show the right element type, selectors are correct.');
  console.log('[inspect] If 0 matches, the UI label is wrong — check the screenshot.');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const inspectIdx = args.indexOf('--inspect');
  const onlyIdx = args.indexOf('--only');
  const verbose = args.includes('--verbose');
  const isInspect = inspectIdx !== -1;
  const inspectTarget = isInspect ? args[inspectIdx + 1] : null;
  const onlyTarget = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  if (isInspect && !inspectTarget) {
    console.error('Usage: --inspect <build-name>  (use the exact key from planner-urls.json)');
    process.exit(1);
  }

  const plannerUrls: PlannerUrls = JSON.parse(
    await readFile(PLANNER_URLS_PATH, 'utf-8'),
  );

  if (inspectTarget && !plannerUrls[inspectTarget]) {
    // Allow raw URL as target too
    if (!inspectTarget.startsWith('http')) {
      console.error(`Build "${inspectTarget}" not found in planner-urls.json`);
      console.error('Available builds:', Object.keys(plannerUrls).join(', '));
      process.exit(1);
    }
  }

  if (onlyTarget && !plannerUrls[onlyTarget]) {
    console.error(`Build "${onlyTarget}" not found in planner-urls.json`);
    console.error('Available builds:', Object.keys(plannerUrls).join(', '));
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !isInspect });
  const skipped: SkippedEntry[] = [];
  let totalSaved = 0;

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });

    const page = await context.newPage();
    await injectClipboardIntercept(page);

    if (isInspect) {
      const targetName = inspectTarget!;
      const targetUrl = plannerUrls[targetName] ?? targetName;
      await runInspectMode(page, targetName, targetUrl);
      return;
    }

    const builds = Object.entries(plannerUrls).filter(
      ([name]) => !onlyTarget || name === onlyTarget,
    );

    if (builds.length === 0) {
      console.error('No builds to process.');
      process.exit(1);
    }

    for (let bi = 0; bi < builds.length; bi++) {
      const [buildName, url] = builds[bi];
      const saved = await extractFiltersForBuild(page, buildName, url, skipped, verbose);
      totalSaved += saved;

      if (bi < builds.length - 1) {
        await page.waitForTimeout(DELAY_BETWEEN_BUILDS_MS);
      }
    }

  } finally {
    await browser.close();

    if (!isInspect) {
      // Write summary
      const summary = { totalSaved, skipped };
      const summaryPath = path.join(OUTPUT_DIR, '_summary.json');
      await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Total saved: ${totalSaved} files`);
      if (skipped.length > 0) {
        console.log(`Skipped:     ${skipped.length} entries`);
        for (const s of skipped) {
          console.log(`  ${s.buildName} / ${s.strictness}: ${s.reason}`);
        }
      }
      console.log(`Summary: ${path.relative(PROJECT_ROOT, path.join(OUTPUT_DIR, '_summary.json'))}`);
    }
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

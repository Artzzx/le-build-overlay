/**
 * extract-planner-exports.ts — Script 2 of 3: Last Epoch Filter Engine Pipeline
 *
 * Automates the Maxroll Planner's native Export function to capture structured
 * equipment JSON per build phase. For each build URL in scripts/data/maxroll/planner-urls.json,
 * iterates available phases (Starter / Endgame / Aspirational / BiS), triggers the
 * "All Equipment" export, intercepts the clipboard write, and stores the result.
 *
 * Outputs:
 *   data/pipeline/planner-exports.json  — structured phase data per build
 *   data/pipeline/planner-warnings.json — failures, unknown IDs, missing phases
 *
 * CLI:
 *   npx tsx scripts/pipeline/extract-planner-exports.ts
 *   npx tsx scripts/pipeline/extract-planner-exports.ts --inspect <slug>
 *   npx tsx scripts/pipeline/extract-planner-exports.ts --only <slug>
 *   npx tsx scripts/pipeline/extract-planner-exports.ts --verbose
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
const PROJECT_ROOT = path.resolve(__dirname, '../../');

const PLANNER_URLS_PATH = path.join(PROJECT_ROOT, '/data/maxroll/planner-urls.json');
const EQUIPMENT_PATH = path.join(PROJECT_ROOT, '../data/mappings/MasterItemsList.json');
const INSPECT_DIR = path.join(PROJECT_ROOT, 'filter-engine/data/maxroll/inspect');
const PLANNERS_OUT_DIR = path.resolve(__dirname, '../../../data/sources/planners');
const WARNINGS_OUT = path.join(PLANNERS_OUT_DIR, 'planner-warnings.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// No longer used as an allowlist — phases are detected dynamically from the dropdown.

const DELAY_BETWEEN_BUILDS_MS = 5000;
const DELAY_BETWEEN_PHASES_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlannerUrls {
  [buildSlug: string]: string;
}

interface ExportAffix {
  id: number;
  tier: number;
  roll: number;
}

interface RawExportItem {
  itemType?: number;
  subType?: number;
  uniqueID?: number;
  uniqueRolls?: number[];
  affixes?: ExportAffix[];
  sealedAffix?: ExportAffix;
  primordialAffix?: ExportAffix;
  implicits?: number[];
}

interface RawExportIdol {
  slot?: number;
  itemType?: number;
  subType?: number;
  affixes?: ExportAffix[];
  implicits?: number[];
}

interface RawExportJson {
  items?: Record<string, RawExportItem>;
  idols?: (RawExportIdol | null)[];
  blessings?: unknown[];
  weaverItems?: unknown[];
}

interface ProcessedItem {
  slot: string;
  itemType: number;
  subType: number;
  uniqueID: number;
  uniqueName: string | null;
  affixes: ExportAffix[];
  sealedAffix: ExportAffix | null;
  primordialAffix: ExportAffix | null;
  implicits: number[];
}

interface ProcessedIdol {
  slot: number;
  itemType: number;
  subType: number;
  affixes: ExportAffix[];
}

interface PhaseData {
  items: Record<string, ProcessedItem>;
  idols: (ProcessedIdol | null)[];
  rawExport: string;
}

interface BuildResult {
  sourceUrl: string;
  scrapedAt: string;
  phasesAvailable: string[];
  phases: Record<string, PhaseData>;
}

interface BuildFailed {
  buildSlug: string;
  url: string;
  phase: string;
  reason: string;
}

interface UnknownUniqueID {
  uniqueID: number;
  buildSlug: string;
  phase: string;
  slot: string;
}

interface PhaseNotFound {
  buildSlug: string;
  expectedPhases: string[];
  foundPhases: string[];
}

interface Warnings {
  buildsFailed: BuildFailed[];
  unknownUniqueIDs: UnknownUniqueID[];
  phasesNotFound: PhaseNotFound[];
}

// ---------------------------------------------------------------------------
// equipment.json types
// ---------------------------------------------------------------------------

interface UniqueEntry {
  uniqueId: number;
  displayName: string;
}

interface SubItemEntry {
  uniques?: Record<string, UniqueEntry>;
}

interface BaseTypeEntry {
  subItems?: Record<string, SubItemEntry>;
}

interface EquipmentJson {
  baseTypes?: Record<string, BaseTypeEntry>;
}

// ---------------------------------------------------------------------------
// Unique name map builder
// Traverses baseTypes → subItems → uniques to build a flat uniqueId → displayName map
// ---------------------------------------------------------------------------

function buildUniqueMap(equipmentJson: EquipmentJson): Map<number, string> {
  const map = new Map<number, string>();
  for (const baseType of Object.values(equipmentJson.baseTypes ?? {})) {
    for (const subItem of Object.values(baseType.subItems ?? {})) {
      for (const unique of Object.values(subItem.uniques ?? {})) {
        map.set(unique.uniqueId, unique.displayName);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert a build/phase name to a snake_case file-safe slug.
 *  "Warpath Void Knight" → "warpath_void_knight"
 *  "BiS"                → "bis"
 */
function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------------
// Clipboard intercept injection
//
// MUST be called via page.addInitScript() BEFORE page.goto() so the intercept
// is active on every page load. Intercepts navigator.clipboard.writeText at the
// JavaScript level — avoids OS clipboard permission requirements.
// ---------------------------------------------------------------------------

async function injectClipboardIntercept(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__capturedClipboard = null;
    // navigator.clipboard may be undefined in headless contexts — guard before patching
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
  // Use the intercept as a timing signal only — wait until the site has written
  // to clipboard at least once, then add a settle delay before reading.
  //
  // WHY: the site writes to clipboard twice for unique items — first with a
  // partial payload (no affix data yet), then again after async unique-data
  // resolution.  Reading the intercepted FIRST write produces empty affixes.
  // Reading via readText() after a brief settle gives the FINAL complete JSON.
  try {
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__capturedClipboard !== null,
      { timeout: timeoutMs },
    );
  } catch {
    // Intercept never fired — proceed anyway and let readText() attempt below handle it
  }

  // Settle delay: allows any secondary clipboard writes (e.g. unique affix async load)
  // to complete before we read the final value
  await page.waitForTimeout(800);

  // Read the FINAL clipboard state — not the first intercepted value
  try {
    return await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    // readText() unavailable — fall back to whatever the intercept captured
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await page.evaluate(() => (window as any).__capturedClipboard as string | null);
  }
}

// ---------------------------------------------------------------------------
// Phase detection
//
// The phase dropdown is a custom React component (not a native <select>).
// Located in the left Equipment panel, directly below the "EQUIPMENT" heading.
// Confirmed phase labels: "Starter", "Endgame", "Aspirational", possibly "BiS".
// Strategy: click the trigger to open, read option text, close with Escape.
// ---------------------------------------------------------------------------

async function detectPhases(page: Page): Promise<string[]> {
  try {
    // Confirmed from HTML inspection: custom React select — plain div with tabindex, no role/button
    // Class: equipment_SelectValue__2wQLH (stable module-scoped name)
    const dropdownTrigger = page.locator('div.equipment_SelectValue__2wQLH').first();

    const isVisible = await dropdownTrigger.isVisible().catch(() => false);
    if (!isVisible) {
      return ['Endgame'];
    }

    await dropdownTrigger.click({ timeout: 5000 });
    await page.waitForTimeout(500);

    // Options are divs with class matching _Select__option_* pattern
    const optionTexts = await page
      .locator('[role="option"], [class*="Option"], [class*="option"]')
      .allTextContents()
      .catch(() => [] as string[]);

    // Deduplicate — sub-elements inside each option can repeat text
    // No allowlist: return whatever the dropdown actually contains
    const phases = [...new Set(optionTexts.map((t) => t.trim()).filter(Boolean))];

    // Close dropdown without selecting
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    return phases.length > 0 ? phases : ['Endgame'];
  } catch {
    return ['Endgame'];
  }
}

// ---------------------------------------------------------------------------
// Phase selection
//
// Opens the custom React phase dropdown and clicks the target phase option.
//
// ROOT CAUSE OF PREVIOUS BUG:
//   The old locator `text="${phaseName}"` matched the build-header tag
//   <span class="header_Tags__tag__3lrov">Endgame</span> (DOM position ~121897)
//   BEFORE the dropdown option <div class="equipment_SetOption__PdDmY">
//   (DOM position ~125287).  Clicking the header tag did nothing, so the
//   phase never changed and Endgame was always exported as a duplicate of
//   whichever phase happened to be current at that moment.
//
// FIX: target the confirmed option class (equipment_SetOption__PdDmY) and
//   filter by phase name substring — this matches only dropdown options, not
//   the header tag.  After clicking, wait for the trigger to confirm the
//   new phase is displayed before proceeding.
// ---------------------------------------------------------------------------

async function selectPhase(page: Page, phaseName: string): Promise<void> {
  // Guard: if a previous modal wasn't fully dismissed, close it now before
  // attempting to click the phase-selector (overlays intercept pointer events)
  const modalOpen = await page
    .locator('text=Import/Export Profile Data')
    .isVisible()
    .catch(() => false);
  if (modalOpen) {
    await dismissExportModal(page);
  }

  // Confirmed from HTML inspection: custom React select — plain div with tabindex, no role/button
  const dropdownTrigger = page.locator('div.equipment_SelectValue__2wQLH').first();

  await dropdownTrigger.click({ timeout: 5000 });
  await page.waitForTimeout(300);

  // Click the option using the confirmed option class (equipment_SetOption__PdDmY).
  // DO NOT use a plain text locator here — the build header also contains the
  // phase name as a tag label and appears earlier in the DOM, causing .first()
  // to click the header instead of the dropdown option.
  await page
    .locator('div.equipment_SetOption__PdDmY')
    .filter({ hasText: phaseName })
    .first()
    .click({ timeout: 5000 });

  // Verify the trigger updated to the selected phase — confirms the click registered.
  // If this times out (silently swallowed), the export will produce wrong data.
  await page
    .locator(`div.equipment_SelectValue__2wQLH:has-text("${phaseName}")`)
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(async () => {
      // Trigger didn't update — log a warning so it's visible in the run output
      console.warn(`  [WARN] Phase selector trigger did not update to "${phaseName}" — export may be for wrong phase`);
    });

  // Wait for React state update after phase switch — use fixed delay, SPA never reaches networkidle
  await page.waitForTimeout(1200);
}

// ---------------------------------------------------------------------------
// Per-phase export capture
//
// Full sequence per spec:
//   1. Reset clipboard buffer
//   2. Click "Export/Import" button (confirmed: top-right, left of "Loot Filter")
//   3. Wait for modal (confirmed title: "Import/Export Profile Data")
//   4. Click "All Equipment" tab (confirmed: clicking it triggers clipboard.writeText)
//   5. Wait for clipboard capture
//   6. Close modal (Escape)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Modal dismissal
//
// Escape alone is unreliable for React portal modals — if the framework does
// not propagate the keyboard event the backdrop stays open and blocks the next
// phase-selector click.  Strategy:
//   1. Escape key (works for well-behaved implementations)
//   2. If modal title still visible: click backdrop at top-left corner (outside
//      the centred dialog, inside the semi-transparent overlay)
//   3. Wait for modal title to be gone, then add a short CSS-transition buffer
// ---------------------------------------------------------------------------

async function dismissExportModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // If Escape didn't close it, click the backdrop corner (outside the dialog)
  const stillOpen = await page
    .locator('text=Import/Export Profile Data')
    .isVisible()
    .catch(() => false);
  if (stillOpen) {
    await page.mouse.click(20, 20);
    await page.waitForTimeout(300);
  }

  // Wait for modal to be fully gone; buffer for CSS fade-out transition
  await page
    .waitForSelector('text=Import/Export Profile Data', { state: 'hidden', timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(400);
}

async function capturePhase(page: Page, phaseName: string): Promise<string> {
  // Reset intercept buffer so a stale value from a previous capture isn't returned
  await resetClipboardCapture(page);

  // Open Export/Import modal
  // Confirmed button label: "Export/Import" — plain text button, top-right of planner
  const exportBtn = page
    .locator(
      'button:has-text("Export/Import"), [role="button"]:has-text("Export/Import")',
    )
    .first();
  await exportBtn.click({ timeout: 5000 });

  // Wait for modal — confirmed modal title text: "Import/Export Profile Data"
  await page.waitForSelector('text=Import/Export Profile Data', { timeout: 5000 });

  try {
    // Click "All Equipment" tab — triggers clipboard.writeText with full export JSON
    await page.locator('text=All Equipment').first().click({ timeout: 5000 });

    // Wait for clipboard to be populated
    const json = await getClipboardCapture(page, 5000);
    if (!json) {
      throw new Error('Clipboard capture timed out after 5000ms');
    }
    return json;
  } finally {
    // Always close the modal — even on error, so it doesn't block subsequent phase clicks
    await dismissExportModal(page);
  }
}

// ---------------------------------------------------------------------------
// Export JSON parsing and enrichment
//
// Parses the raw clipboard JSON, enriches uniqueID → uniqueName via equipment.json,
// and logs warnings for unknown unique IDs.
// ---------------------------------------------------------------------------

function enrichExport(
  rawJson: string,
  buildSlug: string,
  phaseName: string,
  uniqueMap: Map<number, string>,
  warnings: Warnings,
): PhaseData {
  const raw = JSON.parse(rawJson) as RawExportJson;

  const processedItems: Record<string, ProcessedItem> = {};
  for (const [slot, item] of Object.entries(raw.items ?? {})) {
    const uniqueID = item.uniqueID ?? 0;
    let uniqueName: string | null = null;

    if (uniqueID > 0) {
      uniqueName = uniqueMap.get(uniqueID) ?? null;
      if (!uniqueName) {
        warnings.unknownUniqueIDs.push({ uniqueID, buildSlug, phase: phaseName, slot });
      }
    }

    processedItems[slot] = {
      slot,
      itemType: item.itemType ?? 0,
      subType: item.subType ?? 0,
      uniqueID,
      uniqueName,
      affixes: item.affixes ?? [],
      sealedAffix: item.sealedAffix ?? null,
      primordialAffix: item.primordialAffix ?? null,
      implicits: item.implicits ?? [],
    };
  }

  // Idol array preserves null entries (null = empty idol slot in the planner grid)
  const processedIdols: (ProcessedIdol | null)[] = (raw.idols ?? []).map(
    (idol, idx) => {
      if (!idol) return null;
      return {
        slot: idol.slot ?? idx,
        itemType: idol.itemType ?? 0,
        subType: idol.subType ?? 0,
        affixes: idol.affixes ?? [],
      };
    },
  );

  return {
    items: processedItems,
    idols: processedIdols,
    rawExport: rawJson, // preserved as safety net for reprocessing
  };
}

// ---------------------------------------------------------------------------
// Per-build processing
// ---------------------------------------------------------------------------

async function processBuild(
  page: Page,
  buildSlug: string,
  url: string,
  uniqueMap: Map<number, string>,
  warnings: Warnings,
  verbose: boolean,
): Promise<BuildResult> {
  console.log(`  → Navigating to planner...`);
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(3000); // wait for React hydration — SPA never reaches networkidle

  // Dismiss OneTrust cookie consent overlay if present — it blocks all clicks
  const consentBtn = page.locator('#onetrust-accept-btn-handler');
  if (await consentBtn.isVisible().catch(() => false)) {
    await consentBtn.click({ timeout: 3000 });
    await page.waitForSelector('#onetrust-consent-sdk', { state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  // Detect available phases from the Equipment panel dropdown
  const availablePhases = await detectPhases(page);
  console.log(`  → Phases found: ${availablePhases.join(', ')}`);

  const phases: Record<string, PhaseData> = {};
  let phaseIndex = 0;

  for (const phaseName of availablePhases) {
    if (phaseIndex > 0) {
      await sleep(DELAY_BETWEEN_PHASES_MS);
    }

    try {
      // Always explicitly select the phase — the page always loads on Endgame
      // by default regardless of phase order, so skipping selectPhase for the
      // first phase in the list would export the wrong (default) data.
      // Only skip if there is a single phase (dropdown won't exist).
      if (availablePhases.length > 1) {
        await selectPhase(page, phaseName);
      }

      const rawJson = await capturePhase(page, phaseName);

      if (verbose) {
        console.log(`    [${phaseName}] Raw JSON (first 200 chars): ${rawJson.slice(0, 200)}...`);
      }

      const phaseData = enrichExport(rawJson, buildSlug, phaseName, uniqueMap, warnings);
      const itemCount = Object.keys(phaseData.items).length;
      const idolCount = phaseData.idols.filter(Boolean).length;
      console.log(`  → [${phaseName}] Exported: ${itemCount} items, ${idolCount} idols`);

      phases[phaseName] = phaseData;
    } catch (err) {
      console.error(`  ✗ [${phaseName}] Failed: ${err}`);
      warnings.buildsFailed.push({
        buildSlug,
        url,
        phase: phaseName,
        reason: String(err),
      });
      // Screenshot on phase failure for debugging
      await mkdir(INSPECT_DIR, { recursive: true });
      await page
        .screenshot({ path: path.join(INSPECT_DIR, `error-${buildSlug}-${phaseName}.png`) })
        .catch(() => {});
    }

    phaseIndex++;
  }

  console.log(`  ✓ Done (${Object.keys(phases).length} phases)`);

  return {
    sourceUrl: url,
    scrapedAt: new Date().toISOString(),
    phasesAvailable: availablePhases,
    phases,
  };
}

// ---------------------------------------------------------------------------
// Inspect mode
//
// Saves full rendered HTML and a full-page screenshot, then exits.
// Run this first against a real planner URL to confirm selectors before
// implementing phase detection and export trigger logic.
//
// Usage: npx tsx scripts/pipeline/extract-planner-exports.ts --inspect <slug>
// ---------------------------------------------------------------------------

async function runInspectMode(page: Page, buildSlug: string, url: string): Promise<void> {
  await mkdir(INSPECT_DIR, { recursive: true });

  console.log(`[inspect] Build: ${buildSlug}`);
  console.log(`[inspect] URL:   ${url}`);
  console.log(`[inspect] Navigating and waiting for full render...`);

  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await page.waitForTimeout(3000); // wait for React hydration — SPA never reaches networkidle

  const htmlPath = path.join(INSPECT_DIR, `${buildSlug}.html`);
  const pngPath = path.join(INSPECT_DIR, `${buildSlug}.png`);

  const html = await page.content();
  await writeFile(htmlPath, html, 'utf-8');
  await page.screenshot({ path: pngPath, fullPage: true });

  console.log(`[inspect] Saved HTML:       ${htmlPath}`);
  console.log(`[inspect] Saved screenshot: ${pngPath}`);
  console.log(`\n[inspect] Open the HTML file to confirm selectors for:`);
  console.log(`  - Phase dropdown trigger (below "EQUIPMENT" heading)`);
  console.log(`  - Export/Import button (top-right, left of "Loot Filter")`);
  console.log(`  - Modal title ("Import/Export Profile Data")`);
  console.log(`  - "All Equipment" tab inside the modal`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  const inspectIdx = args.indexOf('--inspect');
  const onlyIdx = args.indexOf('--only');
  const verbose = args.includes('--verbose');
  const isInspectMode = inspectIdx !== -1;
  const inspectSlug = isInspectMode ? args[inspectIdx + 1] : null;
  const onlySlug = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  if (isInspectMode && !inspectSlug) {
    console.error('Usage: --inspect <build-slug>');
    process.exit(1);
  }

  console.log(
    '=== extract-planner-exports.ts — Last Epoch Filter Pipeline Script 2 ===\n',
  );

  // Load planner URL config
  let plannerUrls: PlannerUrls = {};
  try {
    plannerUrls = JSON.parse(
      await readFile(PLANNER_URLS_PATH, 'utf-8'),
    ) as PlannerUrls;
    console.log(`Loaded ${Object.keys(plannerUrls).length} build URLs from planner-urls.json`);
  } catch {
    console.error(`Could not read planner URLs from: ${PLANNER_URLS_PATH}`);
    console.error(
      'Create scripts/data/maxroll/planner-urls.json with build slug → planner URL mappings.',
    );
    console.error('Format: { "build_slug": "https://maxroll.gg/last-epoch/planner/HASH" }');
    process.exit(1);
  }

  // Apply --only filter
  if (onlySlug) {
    if (!plannerUrls[onlySlug]) {
      console.error(`Build slug not found in planner-urls.json: ${onlySlug}`);
      console.error(`Available slugs: ${Object.keys(plannerUrls).join(', ')}`);
      process.exit(1);
    }
    plannerUrls = { [onlySlug]: plannerUrls[onlySlug] };
  }

  // Apply --inspect filter
  if (isInspectMode && inspectSlug) {
    const isUrl = inspectSlug.startsWith('http');
    if (!isUrl) {
      if (!plannerUrls[inspectSlug]) {
        console.error(`Build slug not found in planner-urls.json: ${inspectSlug}`);
        console.error(`Available slugs: ${Object.keys(plannerUrls).join(', ')}`);
        process.exit(1);
      }
      plannerUrls = { [inspectSlug]: plannerUrls[inspectSlug] };
    }
  }

  const buildSlugs = Object.keys(plannerUrls);

  if (buildSlugs.length === 0) {
    console.log('No builds to process.');
    console.log('Populate scripts/data/maxroll/planner-urls.json with planner page URLs first.');
    console.log('Planner URLs have the format: https://maxroll.gg/last-epoch/planner/HASH');
    process.exit(0);
  }

  // Load equipment.json for unique name enrichment
  let uniqueMap = new Map<number, string>();
  try {
    const equipJson = JSON.parse(
      await readFile(EQUIPMENT_PATH, 'utf-8'),
    ) as EquipmentJson;
    uniqueMap = buildUniqueMap(equipJson);
    console.log(`Loaded ${uniqueMap.size} unique item names from equipment.json`);
  } catch (err) {
    console.warn(`Could not load equipment.json ${EQUIPMENT_PATH} — uniqueNames will be null for all items`);
  }

  // Initialize Playwright Chromium
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  const page = await context.newPage();

  // CRITICAL: Inject clipboard intercept BEFORE any navigation.
  // addInitScript runs on every page load — must be called before page.goto().
  await injectClipboardIntercept(page);

  // ── Inspect mode ──────────────────────────────────────────────────────────
  if (isInspectMode && inspectSlug) {
    const isUrl = inspectSlug.startsWith('http');
    const inspectUrl = isUrl ? inspectSlug : plannerUrls[inspectSlug];
    const inspectBuildSlug = isUrl
      ? (new URL(inspectSlug).pathname.split('/').pop() ?? 'inspect')
      : inspectSlug;
    try {
      await runInspectMode(page, inspectBuildSlug, inspectUrl);
    } finally {
      await browser.close();
    }
    return;
  }

  // ── Normal / --only mode ──────────────────────────────────────────────────
  const warnings: Warnings = {
    buildsFailed: [],
    unknownUniqueIDs: [],
    phasesNotFound: [],
  };

  const builds: Record<string, BuildResult> = {};
  let totalPhasesCaptured = 0;
  let buildIndex = 0;

  // try/finally guarantees output is written even if the run is interrupted
  // mid-way (crash, Ctrl+C, etc.) — partial results are better than nothing
  try {
    for (const [buildSlug, url] of Object.entries(plannerUrls)) {
      buildIndex++;
      console.log(`\n[${buildIndex}/${buildSlugs.length}] ${buildSlug}`);

      try {
        const result = await processBuild(
          page,
          buildSlug,
          url,
          uniqueMap,
          warnings,
          verbose,
        );
        builds[buildSlug] = result;
        totalPhasesCaptured += Object.keys(result.phases).length;

        // Write phase files immediately — don't defer to finally, which won't
        // run reliably on SIGINT and would lose all captured data on interruption.
        await mkdir(PLANNERS_OUT_DIR, { recursive: true });
        const buildSlugFile = toSlug(buildSlug);
        for (const [phaseName, phaseData] of Object.entries(result.phases)) {
          const filename = `${buildSlugFile}_${toSlug(phaseName)}.json`;
          const outPath = path.join(PLANNERS_OUT_DIR, filename);
          await writeFile(
            outPath,
            JSON.stringify(
              {
                build: buildSlug,
                phase: phaseName,
                sourceUrl: result.sourceUrl,
                scrapedAt: result.scrapedAt,
                items: phaseData.items,
                idols: phaseData.idols,
                rawExport: phaseData.rawExport,
              },
              null,
              2,
            ),
            'utf-8',
          );
          console.log(`  → Saved: ${filename}`);
        }
      } catch (err) {
        console.error(`[FAIL] ${buildSlug}: ${err}`);
        warnings.buildsFailed.push({
          buildSlug,
          url,
          phase: 'unknown',
          reason: String(err),
        });
        // Screenshot on build-level failure
        await mkdir(INSPECT_DIR, { recursive: true });
        await page
          .screenshot({ path: path.join(INSPECT_DIR, `error-${buildSlug}.png`) })
          .catch(() => {});
      }

      // Rate limiting: 5-second delay between builds
      if (buildIndex < buildSlugs.length) {
        await sleep(DELAY_BETWEEN_BUILDS_MS);
      }
    }
  } finally {
    await browser.close();

    // Write warnings file
    await mkdir(PLANNERS_OUT_DIR, { recursive: true });
    await writeFile(WARNINGS_OUT, JSON.stringify(warnings, null, 2), 'utf-8');

    // Summary output
    const buildsProcessed = Object.keys(builds);
    const phaseFailures = warnings.buildsFailed.filter((b) => b.phase !== 'unknown').length;

    console.log('\n' + '─'.repeat(49));
    console.log(
      `Summary: ${buildsProcessed.length}/${buildSlugs.length} builds succeeded | ` +
        `${phaseFailures} phase failures | ${totalPhasesCaptured} total phases captured`,
    );
    console.log(`Output: ${totalPhasesCaptured} phase files → ${PLANNERS_OUT_DIR}`);
    console.log(`Warnings: ${WARNINGS_OUT}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
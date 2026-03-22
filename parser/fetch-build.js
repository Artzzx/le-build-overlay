/**
 * parser/fetch-build.js
 * ──────────────────────
 * Fetch a Last Epoch build plan from:
 *   1. A Maxroll planner URL  — auto-downloads and extracts build JSON
 *   2. In-game export codes   — reads multi-line JSON pasted via stdin
 *
 * Inspiration: the same Export dialog the game uses for equipment
 * (Passives tab → copy code, each Skill tab → copy code) produces one JSON
 * blob per section. This script handles both getting that data automatically
 * (via URL) and manually (paste the codes).
 *
 * ─── How the in-game export works ────────────────────────────────────────────
 *
 *  Open the in-game "Import/Export Profile Data" dialog:
 *    1. Click "Passives"  tab → Export → copy the code    (has class/mastery/passives)
 *    2. Click each Skill  tab → Export → copy the code    (has skillTrees.{treeID})
 *    3. Paste all codes into the overlay's config window, one per line.
 *
 *  The codes are plain JSON objects. mergeRawLines() in maxroll.js reassembles
 *  them into a single build object. This script provides a URL-based shortcut
 *  so users can skip the manual copy-paste entirely.
 *
 * ─── CLI usage ────────────────────────────────────────────────────────────────
 *
 *   # Fetch from Maxroll URL (prints merged JSON to stdout):
 *   node parser/fetch-build.js --url https://maxroll.gg/last-epoch/planner/BUILDID
 *
 *   # Read pasted codes from stdin (pipe or redirect):
 *   node parser/fetch-build.js --manual < my-codes.txt
 *
 *   # Fetch and write directly to config/build.json:
 *   node parser/fetch-build.js --url URL --save
 *   node parser/fetch-build.js --url URL --out path/to/build.json
 *
 * ─── Module API ───────────────────────────────────────────────────────────────
 *
 *   parseMaxrollUrl(urlStr)        → buildId string (validates URL)
 *   fetchPage(urlStr)              → Promise<string> (HTML body)
 *   extractNextData(html)          → object (__NEXT_DATA__ JSON)
 *   findBuildObject(obj)           → object|null (raw Maxroll build)
 *   findBuildInNextData(nextData)  → object (throws if not found)
 *   fetchFromUrl(maxrollUrl)       → Promise<object> (raw Maxroll build)
 *   readFromStdin()                → Promise<string> (raw pasted text)
 */

'use strict';

const https       = require('https');
const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const { URL }     = require('url');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maxroll LE planner URL pattern — captures the build ID */
const MAXROLL_URL_RE = /maxroll\.gg\/last-epoch\/planner\/([a-zA-Z0-9_-]+)/;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS      = 5;

// ─── URL parsing ──────────────────────────────────────────────────────────────

/**
 * Validate a Maxroll LE planner URL and extract the build ID.
 *
 * @param {string} urlStr
 * @returns {string} buildId
 * @throws {Error} if URL doesn't match the expected pattern
 */
function parseMaxrollUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new Error('URL must be a non-empty string');
  }
  const m = urlStr.trim().match(MAXROLL_URL_RE);
  if (!m) {
    throw new Error(
      `Unrecognized URL: "${urlStr.trim()}"\n` +
      'Expected format: https://maxroll.gg/last-epoch/planner/BUILDID'
    );
  }
  return m[1];
}

// ─── HTTP fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL, following up to MAX_REDIRECTS redirects.
 * Uses only Node.js built-in modules — no extra dependencies.
 *
 * @param {string} urlStr
 * @param {number} [redirectsLeft]
 * @returns {Promise<string>} response body (UTF-8)
 */
function fetchPage(urlStr, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const client  = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || undefined,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        // Mimic a browser so Maxroll's CDN doesn't block the request
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    const req = client.request(options, (res) => {
      // Follow redirects (301/302/307/308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.resume();
          return reject(new Error('Too many redirects'));
        }
        res.resume();
        const next = new URL(res.headers.location, urlStr).href;
        return fetchPage(next, redirectsLeft - 1).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${urlStr}`));
      }

      res.setEncoding('utf-8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end',  () => resolve(body));
      res.on('error', reject);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── Next.js page data extraction ────────────────────────────────────────────

/**
 * Extract the __NEXT_DATA__ embedded JSON from a Next.js page.
 * Maxroll uses Next.js; build data is embedded in every planner page.
 *
 * @param {string} html
 * @returns {object} parsed Next.js data object
 * @throws {Error} if __NEXT_DATA__ is absent or malformed
 */
function extractNextData(html) {
  // Match <script id="__NEXT_DATA__" type="application/json">...</script>
  // Attribute order varies; use a flexible pattern.
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) {
    throw new Error(
      '__NEXT_DATA__ JSON block not found in page HTML.\n' +
      'Possible causes:\n' +
      '  • The build ID is invalid or the build was deleted\n' +
      '  • Maxroll changed their page structure (check for updates)\n' +
      '  • The request was blocked by a bot-detection mechanism\n' +
      'Try loading the URL in a browser to verify the build exists.'
    );
  }

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`Failed to parse __NEXT_DATA__ JSON: ${e.message}`);
  }
}

// ─── Build object search ──────────────────────────────────────────────────────

/**
 * Recursively search a nested object for the first value that looks like a
 * Maxroll LE build:
 *   { passives: { history: [...] }, class: <number>, mastery: <number>,
 *     skillTrees: { ... } }
 *
 * This tolerates different nesting depths in Maxroll's pageProps structure
 * without hard-coding a fixed path (which could change between deploys).
 *
 * @param {any} obj
 * @param {number} [depth] — internal recursion guard
 * @returns {object|null}
 */
function findBuildObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findBuildObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Check if this object itself is the build root
  if (
    obj.passives && typeof obj.passives === 'object' &&
    Array.isArray(obj.passives.history) &&
    typeof obj.class   === 'number' &&
    typeof obj.mastery === 'number' &&
    obj.skillTrees && typeof obj.skillTrees === 'object'
  ) {
    return obj;
  }

  // Recurse into values
  for (const val of Object.values(obj)) {
    const found = findBuildObject(val, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Extract the Maxroll build object from a parsed __NEXT_DATA__ object.
 *
 * @param {object} nextData
 * @returns {object} raw Maxroll build JSON
 * @throws {Error} if build data cannot be located
 */
function findBuildInNextData(nextData) {
  const build = findBuildObject(nextData);
  if (!build) {
    throw new Error(
      'Build data not found inside page JSON.\n' +
      'The page loaded but did not contain recognizable build fields\n' +
      '(passives, class, mastery, skillTrees).\n' +
      'Tip: try exporting manually from the Maxroll planner instead.'
    );
  }
  return build;
}

// ─── High-level fetch API ─────────────────────────────────────────────────────

/**
 * Fetch a Last Epoch build from a Maxroll planner URL.
 *
 * Returns the raw Maxroll JSON object — same format as what you get when you
 * click "Export" in the Maxroll planner and copy the JSON manually.
 * Pass the result to parseBuild() in maxroll.js.
 *
 * @param {string} maxrollUrl — e.g. https://maxroll.gg/last-epoch/planner/abc123
 * @returns {Promise<object>} raw Maxroll build object
 * @throws {Error} on network error, bad URL, or missing build data
 */
async function fetchFromUrl(maxrollUrl) {
  const buildId = parseMaxrollUrl(maxrollUrl);
  const pageUrl = `https://maxroll.gg/last-epoch/planner/${buildId}`;

  let html;
  try {
    html = await fetchPage(pageUrl);
  } catch (err) {
    throw new Error(`Network error fetching build "${buildId}": ${err.message}`);
  }

  const nextData = extractNextData(html);
  return findBuildInNextData(nextData);
}

// ─── Manual stdin reader ──────────────────────────────────────────────────────

/**
 * Read in-game export codes from stdin.
 *
 * The user opens the in-game "Import/Export Profile Data" dialog, clicks each
 * tab (Passives, then each skill), exports, and pastes all codes here —
 * one JSON blob per line, just like the Maxroll multi-line export format.
 *
 * Returns the raw pasted string. Pass to mergeRawLines() + parseBuild().
 *
 * @returns {Promise<string>} raw pasted text (trimmed)
 */
function readFromStdin() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    let buf = '';
    process.stdin.on('data',  chunk => { buf += chunk; });
    process.stdin.on('end',   () => resolve(buf.trim()));
    process.stdin.on('error', () => resolve(buf.trim()));
  });
}

// ─── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  parseMaxrollUrl,
  fetchPage,
  extractNextData,
  findBuildObject,
  findBuildInNextData,
  fetchFromUrl,
  readFromStdin,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

/* c8 ignore start */
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    function flag(name)       { return args.includes(name); }
    function flagVal(name)    {
      const i = args.indexOf(name);
      return i !== -1 ? args[i + 1] : null;
    }

    const urlArg    = flagVal('--url');
    const outArg    = flagVal('--out');
    const nameArg   = flagVal('--name');
    const saveFlag  = flag('--save');
    const manual    = flag('--manual');

    if (!urlArg && !manual) {
      console.error(
        'LE Build Overlay — Build Fetcher\n' +
        '\nFetch a build from Maxroll URL:\n' +
        '  node parser/fetch-build.js --url https://maxroll.gg/last-epoch/planner/BUILDID\n' +
        '\nOr paste in-game export codes via stdin:\n' +
        '  node parser/fetch-build.js --manual\n' +
        '\nOptions:\n' +
        '  --url  <URL>   Maxroll planner URL to fetch\n' +
        '  --manual       Read in-game export codes from stdin\n' +
        '  --out  <path>  Write raw Maxroll JSON to file (default: stdout)\n' +
        '  --save         Write directly to config/build.json (shortcut for --out)\n' +
        '  --name <name>  Build name (used with --save)\n'
      );
      process.exit(1);
    }

    let rawJson;

    try {
      if (urlArg) {
        process.stderr.write(`Fetching build from: ${urlArg}\n`);
        const buildObj = await fetchFromUrl(urlArg);
        rawJson = JSON.stringify(buildObj, null, 2);
        process.stderr.write('Build data extracted successfully.\n');
      } else {
        // Manual mode — read from stdin
        process.stderr.write(
          'Paste in-game export codes below (one JSON line per section).\n' +
          'Press Ctrl+D (Linux/Mac) or Ctrl+Z then Enter (Windows) when done:\n\n'
        );
        rawJson = await readFromStdin();
        if (!rawJson) {
          console.error('No input received.');
          process.exit(1);
        }
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }

    // Determine output destination
    let outPath = outArg;
    if (!outPath && saveFlag) {
      outPath = path.join(__dirname, '..', 'config', 'build-raw.json');
    }

    if (outPath) {
      // Parse + re-serialize to validate, then write raw for the overlay to load
      try {
        const { mergeRawLines } = require('./maxroll');
        // mergeRawLines validates the JSON structure
        const merged = mergeRawLines(rawJson);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf-8');
        process.stderr.write(`Written to: ${outPath}\n`);
        if (saveFlag) {
          process.stderr.write(
            'Now open the overlay config window (F5) and load the build,\n' +
            `or run: node -e "require('./parser/maxroll').parseBuild(require('./config/build-raw.json'), ...)\n`
          );
        }
      } catch (err) {
        console.error(`Failed to write output: ${err.message}`);
        process.exit(1);
      }
    } else {
      // Print to stdout so the caller can pipe/capture
      process.stdout.write(rawJson + '\n');
    }
  })();
}
/* c8 ignore end */

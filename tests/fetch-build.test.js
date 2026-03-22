/**
 * tests/fetch-build.test.js
 * ──────────────────────────
 * Tests for parser/fetch-build.js
 *
 * Covers all pure functions (URL parsing, HTML extraction, build search).
 * The network-dependent fetchPage() is not unit-tested here — those are
 * integration tests that require a live connection.
 *
 * Run: npm test
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMaxrollUrl,
  extractNextData,
  findBuildObject,
  findBuildInNextData,
} = require('../parser/fetch-build');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid Maxroll build object */
const SAMPLE_BUILD = {
  passives:   { history: [1, 1, 6, 6, 6], position: 5 },
  class:      4,
  mastery:    2,
  skillTrees: {
    htsk5: { history: [9, 10, 1, 4], position: 4 },
    smbmb: { history: [17, 18, 16],  position: 3 },
  },
};

/** Simulate a Next.js __NEXT_DATA__ page wrapping a build */
function makeNextDataHtml(buildObj, wrapPath = 'props.pageProps.build') {
  // Build nested object from dot-path: 'props.pageProps.build' → { props: { pageProps: { build: ... } } }
  const keys = wrapPath.split('.').reverse();
  let nested = buildObj;
  for (const k of keys) nested = { [k]: nested };

  const json = JSON.stringify(nested);
  return `<!DOCTYPE html><html><head>
<script id="__NEXT_DATA__" type="application/json">${json}</script>
</head><body></body></html>`;
}

// ─── parseMaxrollUrl ──────────────────────────────────────────────────────────

describe('parseMaxrollUrl', () => {
  test('extracts build ID from standard URL', () => {
    const id = parseMaxrollUrl('https://maxroll.gg/last-epoch/planner/abc123');
    assert.equal(id, 'abc123');
  });

  test('extracts build ID with mixed case and hyphens', () => {
    const id = parseMaxrollUrl('https://maxroll.gg/last-epoch/planner/xY9-Zw');
    assert.equal(id, 'xY9-Zw');
  });

  test('works with trailing slash in URL', () => {
    // The regex captures up to the first non-alphanum-hyphen-underscore char
    const id = parseMaxrollUrl('https://maxroll.gg/last-epoch/planner/abcdef/');
    assert.equal(id, 'abcdef');
  });

  test('works with query string after build ID', () => {
    const id = parseMaxrollUrl('https://maxroll.gg/last-epoch/planner/build99?ref=foo');
    assert.equal(id, 'build99');
  });

  test('throws on empty string', () => {
    assert.throws(() => parseMaxrollUrl(''), /non-empty/);
  });

  test('throws on non-string input', () => {
    assert.throws(() => parseMaxrollUrl(null), /non-empty/);
  });

  test('throws on completely wrong URL (no maxroll.gg)', () => {
    assert.throws(
      () => parseMaxrollUrl('https://example.com/planner/abc'),
      /Unrecognized URL/
    );
  });

  test('throws on Maxroll URL for wrong game', () => {
    assert.throws(
      () => parseMaxrollUrl('https://maxroll.gg/poe2/planner/abc'),
      /Unrecognized URL/
    );
  });

  test('throws when planner path segment is missing', () => {
    assert.throws(
      () => parseMaxrollUrl('https://maxroll.gg/last-epoch/'),
      /Unrecognized URL/
    );
  });
});

// ─── extractNextData ──────────────────────────────────────────────────────────

describe('extractNextData', () => {
  test('extracts JSON from standard Next.js __NEXT_DATA__ tag', () => {
    const html = makeNextDataHtml(SAMPLE_BUILD);
    const data = extractNextData(html);
    // The extracted JSON is wrapped; we just check it's an object
    assert.ok(data && typeof data === 'object');
  });

  test('returns the full nested object including the build', () => {
    const html = makeNextDataHtml(SAMPLE_BUILD);
    const data = extractNextData(html);
    const build = findBuildObject(data);
    assert.ok(build, 'build should be findable inside extracted data');
    assert.equal(build.class, 4);
  });

  test('works when attribute order is reversed (type before id)', () => {
    const json = JSON.stringify({ foo: SAMPLE_BUILD });
    const html = `<html><script type="application/json" id="__NEXT_DATA__">${json}</script></html>`;
    const data = extractNextData(html);
    assert.ok(typeof data === 'object');
  });

  test('throws if __NEXT_DATA__ tag is absent', () => {
    assert.throws(
      () => extractNextData('<html><body>Hello</body></html>'),
      /__NEXT_DATA__/
    );
  });

  test('throws on malformed JSON inside __NEXT_DATA__', () => {
    const html = `<html><script id="__NEXT_DATA__" type="application/json">{not json}</script></html>`;
    assert.throws(
      () => extractNextData(html),
      /parse.*NEXT_DATA|NEXT_DATA.*parse/i
    );
  });

  test('handles build nested deeper in props.pageProps', () => {
    const html = makeNextDataHtml(SAMPLE_BUILD, 'props.pageProps.initialBuild');
    const data = extractNextData(html);
    const build = findBuildObject(data);
    assert.ok(build);
    assert.equal(build.mastery, 2);
  });
});

// ─── findBuildObject ──────────────────────────────────────────────────────────

describe('findBuildObject', () => {
  test('finds build at top level', () => {
    const result = findBuildObject(SAMPLE_BUILD);
    assert.deepEqual(result, SAMPLE_BUILD);
  });

  test('finds build nested one level deep', () => {
    const result = findBuildObject({ data: SAMPLE_BUILD });
    assert.deepEqual(result, SAMPLE_BUILD);
  });

  test('finds build nested several levels deep', () => {
    const nested = { props: { pageProps: { initialBuild: SAMPLE_BUILD } } };
    const result = findBuildObject(nested);
    assert.deepEqual(result, SAMPLE_BUILD);
  });

  test('finds build inside an array', () => {
    const result = findBuildObject({ items: [{ other: 1 }, SAMPLE_BUILD] });
    assert.deepEqual(result, SAMPLE_BUILD);
  });

  test('returns null for primitive', () => {
    assert.equal(findBuildObject(42), null);
    assert.equal(findBuildObject('string'), null);
    assert.equal(findBuildObject(null), null);
  });

  test('returns null for empty object', () => {
    assert.equal(findBuildObject({}), null);
  });

  test('returns null if passives.history is missing', () => {
    const bad = { ...SAMPLE_BUILD, passives: { position: 5 } }; // no history array
    assert.equal(findBuildObject(bad), null);
  });

  test('returns null if class is not a number', () => {
    const bad = { ...SAMPLE_BUILD, class: '4' }; // string instead of number
    assert.equal(findBuildObject(bad), null);
  });

  test('returns null if skillTrees is missing', () => {
    const { skillTrees: _, ...noSkills } = SAMPLE_BUILD;
    assert.equal(findBuildObject(noSkills), null);
  });

  test('returns first match when multiple builds are present', () => {
    const build2 = { ...SAMPLE_BUILD, class: 99 };
    const result = findBuildObject({ a: SAMPLE_BUILD, b: build2 });
    // Should return one of the two (the first one encountered)
    assert.ok(result === SAMPLE_BUILD || result === build2);
  });

  test('stops recursing past depth 12', () => {
    // Build a deeply nested object (depth > 12) to verify the guard doesn't hang
    let obj = SAMPLE_BUILD;
    for (let i = 0; i < 14; i++) obj = { wrap: obj };
    // Should return null (too deep) without hanging
    const result = findBuildObject(obj);
    assert.equal(result, null);
  });
});

// ─── findBuildInNextData ──────────────────────────────────────────────────────

describe('findBuildInNextData', () => {
  test('returns build when found', () => {
    const nextData = { props: { pageProps: { build: SAMPLE_BUILD } } };
    const result = findBuildInNextData(nextData);
    assert.deepEqual(result, SAMPLE_BUILD);
  });

  test('throws descriptive error when build is not found', () => {
    assert.throws(
      () => findBuildInNextData({ foo: 'bar', props: {} }),
      /not found|passives|skillTrees/i
    );
  });

  test('throws when passed null', () => {
    assert.throws(() => findBuildInNextData(null));
  });

  test('works with real-ish Next.js shape', () => {
    const nextData = {
      props: {
        pageProps: {
          meta: { title: 'Rogue Build', author: 'user123' },
          planner: {
            version: 2,
            data: SAMPLE_BUILD,   // nested under planner.data
          },
        },
      },
      page: '/last-epoch/planner/[id]',
      query: { id: 'abc123' },
    };
    const result = findBuildInNextData(nextData);
    assert.equal(result.class, 4);
    assert.equal(result.mastery, 2);
    assert.ok(Array.isArray(result.passives.history));
  });
});

// ─── Integration: extractNextData → findBuildInNextData ───────────────────────

describe('extractNextData + findBuildInNextData (pipeline)', () => {
  test('full pipeline: HTML → extracted build', () => {
    const html = makeNextDataHtml(SAMPLE_BUILD);
    const nextData = extractNextData(html);
    const build = findBuildInNextData(nextData);
    assert.equal(build.class, 4);
    assert.equal(build.mastery, 2);
    assert.deepEqual(build.passives.history, SAMPLE_BUILD.passives.history);
    assert.ok(build.skillTrees.htsk5);
    assert.ok(build.skillTrees.smbmb);
  });

  test('pipeline handles build nested under initialBuild key', () => {
    const html = makeNextDataHtml(SAMPLE_BUILD, 'props.pageProps.initialBuild');
    const nextData = extractNextData(html);
    const build = findBuildInNextData(nextData);
    assert.equal(build.class, 4);
  });

  test('extracted build is compatible with mergeRawLines (same shape)', () => {
    // mergeRawLines expects the merged Maxroll format; findBuildObject returns exactly that
    const { mergeRawLines } = require('../parser/maxroll');
    const html = makeNextDataHtml(SAMPLE_BUILD);
    const nextData = extractNextData(html);
    const buildObj = findBuildInNextData(nextData);

    // mergeRawLines on a single-object JSON string should just parse it
    const jsonStr = JSON.stringify(buildObj);
    const merged = mergeRawLines(jsonStr);

    assert.equal(merged.class, SAMPLE_BUILD.class);
    assert.equal(merged.mastery, SAMPLE_BUILD.mastery);
    assert.deepEqual(merged.passives.history, SAMPLE_BUILD.passives.history);
    assert.ok(merged.skillTrees.htsk5);
  });
});

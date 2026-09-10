#!/usr/bin/env node

// Keeps the Ranobehub plugin's filter catalogue in sync with the live site.
//
// The plugin ships the site's genre and event catalogue as ~900 hardcoded
// options — 88% of its minified payload. The site renders that whole catalogue
// into the initial HTML of /ranobe (as the `facets` object of the RSC flight
// payload), so it can be extracted and rewritten mechanically instead of
// hand-edited: see scripts/live-check-plugin.js for the plugin-side checks.
//
// Usage:
//   node scripts/update-ranobehub-filters.js           # rewrite the catalogue
//   node scripts/update-ranobehub-filters.js --check   # report drift, exit 1
//
// Managed filters: tags, events, country, status. `sort` is deliberately not
// managed — the site keeps its sort list in the client bundle, not in facets.
//
// Regeneration emits the site's own order (most-used first, the order the
// site's filter UI shows). --check fails only on *content* drift (added,
// removed and renamed entries) and reports ordering drift as a note, so a
// cosmetic reordering alone does not fail a CI run.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const SITE = 'https://ranobehub.org';
const CATALOG_PAGE = `${SITE}/ranobe`;
const PLUGIN_PATH = path.join(REPO_ROOT, 'plugins/russian/ranobehub.ts');
const USER_AGENT = 'Mozilla/5.0 (compatible; lnreader-plugins filter sync)';

/** Plugin filter key -> key inside the site's `facets` object. */
const MANAGED_FILTERS = {
  tags: 'tags',
  events: 'events',
  country: 'countries',
  status: 'statuses',
};

/** Options the plugin adds that the site's facets do not contain. */
const EXTRA_OPTIONS = {
  // The status Picker needs an explicit "no filter" entry; its value is ''.
  status: [{ label: 'Любой', value: '' }],
};

// Refuse to rewrite the catalogue if the extracted one is much smaller than the
// one already in the repo — that means a partial payload or a changed page
// shape, not a site that dropped 800 tags.
const MAX_SHRINK = 0.5;

const OPTION_PATTERN =
  /label:\s*'((?:[^'\\]|\\.)*)'\s*,\s*value:\s*'((?:[^'\\]|\\.)*)'/g;

const normaliseLabel = value =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const escapeSingleQuoted = value =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const unescapeSingleQuoted = value => value.replace(/\\(['\\])/g, '$1');

function unescapeJsString(value) {
  return value
    .replace(
      /\\(["\\/bfnrt])/g,
      (_, code) =>
        ({
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        })[code],
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Index just past the `}` that closes the `{` at `start`, skipping strings. */
function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('Unbalanced braces while reading the page payload');
}

async function fetchFacets() {
  const response = await fetch(CATALOG_PAGE, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`${CATALOG_PAGE} responded ${response.status}`);
  }
  return extractFacets(await response.text());
}

function extractFacets(html) {
  const payloads = [
    ...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g),
  ].map(match => match[1]);
  if (payloads.length === 0) {
    throw new Error(
      'No Next.js flight payload found on the catalog page — the page structure changed',
    );
  }

  const flight = payloads.map(unescapeJsString).join('');
  const facetsAt = flight.indexOf('"facets"');
  if (facetsAt === -1) {
    throw new Error(
      'No `facets` object in the page payload — the catalog page changed',
    );
  }

  const objectStart = flight.indexOf('{', facetsAt);
  const facets = JSON.parse(
    flight.slice(objectStart, findMatchingBrace(flight, objectStart)),
  );

  for (const facetsKey of Object.values(MANAGED_FILTERS)) {
    if (!Array.isArray(facets[facetsKey]) || facets[facetsKey].length === 0) {
      throw new Error(
        `facets.${facetsKey} is missing or empty — refusing to rewrite the catalogue`,
      );
    }
  }
  return facets;
}

function findFilterBlock(source, key) {
  const start = source.indexOf(`\n    ${key}: {`);
  if (start === -1) {
    throw new Error(`Filter "${key}" not found in the plugin`);
  }
  const end = source.indexOf('\n    },', start);
  if (end === -1) {
    throw new Error(`Could not find the end of filter "${key}"`);
  }
  return { start: start + 1, end };
}

/**
 * Absolute offsets of a filter's `options: [...]` array. Scoping reads and
 * writes to the array matters: matching `label:`/`value:` across the whole
 * filter block also picks up the filter's own `label`/`value` pair (which is
 * a quoted string for a Picker such as `status`).
 */
function findOptionsRange(source, key) {
  const { start, end } = findFilterBlock(source, key);
  const block = source.slice(start, end);
  const openAt = block.indexOf('      options: [');
  if (openAt === -1) {
    throw new Error(`Filter "${key}" has no options array`);
  }
  const closeMarker = '\n      ],';
  const closeAt = block.indexOf(closeMarker, openAt);
  if (closeAt === -1) {
    throw new Error(`Could not find the end of the options array for "${key}"`);
  }
  return {
    contentStart: start + openAt + '      options: ['.length,
    contentEnd: start + closeAt,
    arrayStart: start + openAt,
    arrayEnd: start + closeAt + closeMarker.length,
  };
}

function readPluginOptions(source, key) {
  const { contentStart, contentEnd } = findOptionsRange(source, key);
  const options = [
    ...source.slice(contentStart, contentEnd).matchAll(OPTION_PATTERN),
  ].map(match => ({
    label: unescapeSingleQuoted(match[1]),
    value: unescapeSingleQuoted(match[2]),
  }));
  if (options.length === 0) {
    throw new Error(`No options parsed for filter "${key}"`);
  }
  return options;
}

function replacePluginOptions(source, key, options) {
  const { arrayStart, arrayEnd } = findOptionsRange(source, key);

  const rendered = [
    '      options: [',
    ...options.map(
      ({ label, value }) =>
        `        { label: '${escapeSingleQuoted(label)}', value: '${escapeSingleQuoted(value)}' },`,
    ),
    '      ],',
  ].join('\n');

  return source.slice(0, arrayStart) + rendered + source.slice(arrayEnd);
}

function expectedOptions(facets, key) {
  return [
    ...(EXTRA_OPTIONS[key] ?? []),
    ...facets[MANAGED_FILTERS[key]].map(item => ({
      label: normaliseLabel(item.title),
      value: String(item.id),
    })),
  ];
}

function compareOptions(current, expected) {
  const currentByValue = new Map(current.map(o => [o.value, o.label]));
  const expectedByValue = new Map(expected.map(o => [o.value, o.label]));

  const added = [...expectedByValue].filter(
    ([value]) => !currentByValue.has(value),
  );
  const removed = [...currentByValue].filter(
    ([value]) => !expectedByValue.has(value),
  );
  const renamed = [...expectedByValue]
    .filter(
      ([value, label]) =>
        currentByValue.has(value) && currentByValue.get(value) !== label,
    )
    .map(([value, label]) => [value, currentByValue.get(value), label]);

  const currentCommon = current
    .map(o => o.value)
    .filter(value => expectedByValue.has(value));
  const expectedCommon = expected
    .map(o => o.value)
    .filter(value => currentByValue.has(value));
  const orderingDiffers =
    currentCommon.length === expectedCommon.length &&
    currentCommon.some((value, index) => value !== expectedCommon[index]);

  return { added, removed, renamed, orderingDiffers };
}

function formatDrift(label, entries, describe) {
  return entries
    .slice(0, 5)
    .map(
      (entry, index) =>
        `      ${index === 0 ? label : ' '.repeat(label.length)} ${describe(entry)}`,
    )
    .join('\n');
}

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  const facets = await fetchFacets();

  const source = await fs.readFile(PLUGIN_PATH, 'utf8');
  let next = source;
  const problems = [];
  const notes = [];

  for (const key of Object.keys(MANAGED_FILTERS)) {
    const current = readPluginOptions(source, key);
    const expected = expectedOptions(facets, key);
    const { added, removed, renamed, orderingDiffers } = compareOptions(
      current,
      expected,
    );

    if (expected.length < current.length * (1 - MAX_SHRINK)) {
      throw new Error(
        `facets.${MANAGED_FILTERS[key]} has ${expected.length} entries but the plugin has ${current.length} — refusing to shrink the catalogue this far`,
      );
    }

    if (added.length || removed.length || renamed.length) {
      problems.push(
        `${key}: ${added.length} added, ${removed.length} removed, ${renamed.length} renamed`,
      );
      if (added.length) {
        console.log(
          formatDrift(
            `${key} added:`,
            added,
            ([value, label]) => `${value} = "${label}"`,
          ),
        );
      }
      if (removed.length) {
        console.log(
          formatDrift(
            `${key} removed:`,
            removed,
            ([value, label]) => `${value} = "${label}"`,
          ),
        );
      }
      if (renamed.length) {
        console.log(
          formatDrift(
            `${key} renamed:`,
            renamed,
            ([value, from, to]) => `${value} "${from}" -> "${to}"`,
          ),
        );
      }
      next = replacePluginOptions(next, key, expected);
    } else if (orderingDiffers) {
      notes.push(`${key}: same entries, different order than the site's`);
      next = replacePluginOptions(next, key, expected);
    } else {
      console.log(`✅ ${key}: ${current.length} options in sync`);
    }
  }

  for (const note of notes) console.log(`ℹ️  ${note}`);

  if (checkOnly) {
    if (problems.length) {
      console.error(
        `\n❌ Filter catalogue drift detected:\n  ${problems.join('\n  ')}\nRun "node scripts/update-ranobehub-filters.js" to sync it.`,
      );
      process.exitCode = 1;
    } else {
      console.log('\n✅ Filter catalogue is in sync with the live site.');
    }
    return;
  }

  if (next === source) {
    console.log('\n✅ Nothing to write — catalogue already matches the site.');
    return;
  }

  const prettierConfig = (await prettier.resolveConfig(PLUGIN_PATH)) ?? {};
  const formatted = await prettier.format(next, {
    ...prettierConfig,
    filepath: PLUGIN_PATH,
  });
  await fs.writeFile(PLUGIN_PATH, formatted);
  console.log(
    `\n✅ Rewrote the catalogue in ${path.relative(REPO_ROOT, PLUGIN_PATH)}`,
  );
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
});

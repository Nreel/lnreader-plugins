#!/usr/bin/env node

// Bundles one or more LNReader plugin source files and runs them against the
// real target site, exercising the same PluginBase surface a live install
// would use. Type-checking/lint alone have missed real bugs (zero chapters,
// search leaking foreign-language pages) that only show up when the plugin
// actually talks to its site — see docs/testing.md.

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path, { dirname } from 'path';
import fs from 'fs/promises';
import os from 'os';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

const MIN_CHAPTER_LENGTH = 200;
const STEP_TIMEOUT_MS = 30_000;
const CLOUDFLARE_HEADER_HINTS = ['cf-ray', 'cf-cache-status', 'cf-request-id'];
// Upper bound on how many options of a single filter the live check probes, so
// a plugin declaring hundreds of options does not turn into hundreds of
// requests per CI run.
const MAX_FILTER_PROBES = 3;

/** @typedef {'PASS' | 'FAIL' | 'INCONCLUSIVE'} StepStatus */

function isNetworkOrBlockError(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || '');
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return { inconclusive: true, reason: `Network error (${code})` };
  }
  if (/timed? ?out/i.test(message)) {
    return { inconclusive: true, reason: 'Timeout' };
  }
  // Only 403/503 indicate a block — a cf-ray/cf-cache-status header alone
  // just means the site is fronted by Cloudflare's CDN (true for a huge
  // share of the web) and says nothing about whether we were blocked.
  const status = error?.response?.status ?? error?.status;
  if (status === 403 || status === 503) {
    const headers = error?.response?.headers;
    const headerKeys = headers
      ? Object.keys(
          typeof headers.entries === 'function'
            ? Object.fromEntries(headers.entries())
            : headers,
        ).map(k => k.toLowerCase())
      : [];
    const isCloudflare = CLOUDFLARE_HEADER_HINTS.some(h =>
      headerKeys.includes(h),
    );
    return {
      inconclusive: true,
      reason: `HTTP ${status}${isCloudflare ? ' (Cloudflare)' : ' (likely anti-bot block)'}`,
    };
  }
  return { inconclusive: false };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${label} timed out`), { code: 'ETIMEDOUT' }),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function bundlePlugin(pluginPath) {
  const absPath = path.resolve(REPO_ROOT, pluginPath);
  const result = await esbuild.build({
    entryPoints: [absPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    alias: {
      '@libs': path.join(REPO_ROOT, 'src/libs'),
      '@': path.join(REPO_ROOT, 'src'),
    },
  });
  const code = result.outputFiles[0].text;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpFile = path.join(
    os.tmpdir(),
    `live-check-${path.basename(pluginPath, '.ts')}-${unique}.cjs`,
  );
  await fs.writeFile(tmpFile, code, 'utf8');
  return tmpFile;
}

async function loadPluginInstance(pluginPath) {
  const bundledPath = await bundlePlugin(pluginPath);
  try {
    // Plain CJS require(), not ESM import() — importing a CJS module from an
    // ESM context wraps the whole `module.exports` as `.default` (so a
    // `default` *named* export inside it ends up double-nested at
    // `mod.default.default`). require() resolves it the way the plugin
    // author actually wrote it: `export default plugin` -> `mod.default`.
    const mod = require(bundledPath);
    return mod.default ?? mod;
  } finally {
    delete require.cache[require.resolve(bundledPath)];
    await fs.unlink(bundledPath).catch(() => undefined);
  }
}

function makeStep(name) {
  return { name, status: /** @type {StepStatus} */ ('FAIL'), detail: '' };
}

/**
 * The real app always calls popularNovels with the plugin's own default
 * filter values (from its `filters` schema), never a bare `undefined` -
 * `undefined` is only valid for plugins that declare no filters at all.
 * Passing it to a plugin that assumes its filters are populated (e.g.
 * `options.filters.language`) produces a crash that looks like a plugin bug
 * but is really just an unrealistic call from the harness.
 */
function defaultFilterValues(plugin) {
  if (!plugin.filters) return undefined;
  // FilterToValues<Filters> keeps the {value, type} shape per key — plugins
  // read e.g. filters.language.value, not filters.language directly.
  return Object.fromEntries(
    Object.entries(plugin.filters).map(([key, filter]) => [
      key,
      { value: filter.value, type: filter.type },
    ]),
  );
}

/** Replace one filter's value, keeping the {value, type} shape plugins read. */
function withProbedValue(defaults, key, value) {
  return { ...defaults, [key]: { ...defaults[key], value } };
}

/** Mirrors the FilterTypes enum in src/types/filters.ts. */
const FilterTypeName = {
  Text: 'Text',
  Picker: 'Picker',
  Checkbox: 'Checkbox',
  Switch: 'Switch',
  ExcludableCheckbox: 'XCheckbox',
};

/**
 * Options worth probing for a single filter: declared order, skipping the
 * filter's own default value (re-testing the default proves nothing) and
 * capped at MAX_FILTER_PROBES.
 */
function probeOptions(filter) {
  const options = Array.isArray(filter?.options) ? filter.options : [];
  const isGroup =
    filter?.type === FilterTypeName.Checkbox ||
    filter?.type === FilterTypeName.ExcludableCheckbox;
  return options
    .filter(option => option && typeof option.value === 'string')
    .filter(option => option.value !== '')
    .filter(option => (isGroup ? true : option.value !== filter.value))
    .slice(0, MAX_FILTER_PROBES);
}

/** Build the filter value a user would produce by picking one option. */
function valueForProbe(filter, optionValue) {
  switch (filter?.type) {
    case FilterTypeName.Picker:
    case FilterTypeName.Text:
      return optionValue;
    case FilterTypeName.Checkbox:
      return [optionValue];
    case FilterTypeName.ExcludableCheckbox:
      return { include: [optionValue], exclude: [] };
    case FilterTypeName.Switch:
      return true;
    default:
      return undefined;
  }
}

function declaredValueMatchesType(type, value) {
  switch (type) {
    case FilterTypeName.Picker:
    case FilterTypeName.Text:
      return typeof value === 'string';
    case FilterTypeName.Switch:
      return typeof value === 'boolean';
    case FilterTypeName.Checkbox:
      return Array.isArray(value) && value.every(v => typeof v === 'string');
    case FilterTypeName.ExcludableCheckbox:
      return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value.include === undefined || Array.isArray(value.include)) &&
        (value.exclude === undefined || Array.isArray(value.exclude))
      );
    default:
      return true;
  }
}

function requestSignature(requests) {
  return [...new Set(requests)].sort().join('\n');
}

/**
 * Record every URL the plugin fetches while `run` executes. Plugins reach the
 * network through @libs/fetch, which calls the global fetch at call time, so
 * patching globalThis.fetch observes every request without any test double in
 * the plugin itself.
 */
async function withRequestCapture(run) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    return originalFetch(input, init);
  };
  try {
    return { value: await run(), requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Offline schema checks on the plugin's declared filters. Runs before any
 * network call so a broken filter definition is still reported when the target
 * site is unreachable.
 */
function checkFilterSchema(plugin) {
  const filters = plugin.filters;
  if (!filters || Object.keys(filters).length === 0) return null;
  const step = makeStep('filterIntegrity');
  const problems = [];
  const notes = [];
  let optionCount = 0;

  for (const [key, filter] of Object.entries(filters)) {
    const { type, value, options } = filter ?? {};
    const needsOptions = [
      FilterTypeName.Picker,
      FilterTypeName.Checkbox,
      FilterTypeName.ExcludableCheckbox,
    ].includes(type);

    if (needsOptions && (!Array.isArray(options) || options.length === 0)) {
      problems.push(`"${key}" (${type}) declares no options`);
      continue;
    }
    if (!declaredValueMatchesType(type, value)) {
      problems.push(
        `"${key}" (${type}) default value does not match its type: ${JSON.stringify(value)}`,
      );
    }
    if (!Array.isArray(options)) continue;

    const seen = new Set();
    const duplicates = new Set();
    for (const option of options) {
      optionCount += 1;
      if (
        typeof option?.label !== 'string' ||
        option.label.trim() === '' ||
        // An empty value is legitimate — a Picker's "Any" option is `''`, and
        // plugins read that as "no filter applied". Only a missing value is a bug.
        typeof option?.value !== 'string'
      ) {
        problems.push(
          `"${key}" has an option with an empty label or value: ${JSON.stringify(option)}`,
        );
        continue;
      }
      if (seen.has(option.value)) duplicates.add(option.value);
      seen.add(option.value);
    }
    // A duplicate value is harmless at runtime (the app just shows two identical
    // checkboxes), so it is reported rather than failed — failing on it would
    // retroactively break unrelated plugins that already ship one.
    if (duplicates.size > 0) {
      notes.push(`"${key}" repeats value(s) ${[...duplicates].join(', ')}`);
    }
  }

  const filterCount = Object.keys(filters).length;
  if (problems.length > 0) {
    step.status = 'FAIL';
    step.detail = problems.slice(0, 3).join('; ');
    return step;
  }
  step.status = 'PASS';
  step.detail = `${filterCount} filters, ${optionCount} options${
    notes.length > 0 ? ` (${notes.slice(0, 2).join('; ')})` : ''
  }`;
  return step;
}

/**
 * Exercise the plugin with non-default filter values — the app's filter menu
 * sends these, but the default-values call in step 1 never does. A filter that
 * produces the same request as the defaults is silently doing nothing, which is
 * exactly how an unread `.value.exclude` hides.
 */
async function runFilterMatrix(plugin, defaults, defaultRequests) {
  const filters = plugin.filters;
  if (!filters || Object.keys(filters).length === 0) return [];

  const matrixStep = makeStep('filterMatrix');
  const excludeStep = makeStep('filterExcludeHandling');
  const steps = [matrixStep, excludeStep];
  const defaultSignature = requestSignature(defaultRequests);
  const failures = [];
  const probed = [];
  let excludeProbes = 0;
  const excludableKeys = Object.entries(filters)
    .filter(([, filter]) => filter?.type === FilterTypeName.ExcludableCheckbox)
    .map(([key]) => key);

  for (const [key, filter] of Object.entries(filters)) {
    for (const option of probeOptions(filter)) {
      const probeFilters = withProbedValue(
        defaults,
        key,
        valueForProbe(filter, option.value),
      );
      try {
        const { value: novels, requests } = await withTimeout(
          withRequestCapture(() =>
            plugin.popularNovels(1, { filters: probeFilters }),
          ),
          STEP_TIMEOUT_MS,
          `popularNovels(${key}=${option.label})`,
        );
        if (!Array.isArray(novels) || novels.length === 0) {
          failures.push(`"${key}" = "${option.label}" returned no novels`);
          continue;
        }
        if (requestSignature(requests) === defaultSignature) {
          failures.push(
            `"${key}" = "${option.label}" sent the same request as the default filters (filter has no effect)`,
          );
          continue;
        }
        probed.push(`${key}=${option.value}`);
      } catch (error) {
        const net = isNetworkOrBlockError(error);
        if (net.inconclusive) {
          matrixStep.status = 'INCONCLUSIVE';
          matrixStep.detail = net.reason || error.message;
          excludeStep.status = 'INCONCLUSIVE';
          excludeStep.detail =
            'Skipped — filter probes could not reach the site';
          return steps;
        }
        failures.push(`"${key}" = "${option.label}" threw: ${error.message}`);
      }
    }

    // An ExcludableCheckboxGroup promises the user an exclude toggle. If
    // excluding changes nothing about the outgoing request, that promise is
    // broken — either read `.value.exclude` or declare a plain CheckboxGroup.
    if (!excludableKeys.includes(key)) continue;
    const option = probeOptions(filter)[0];
    if (!option) continue;
    excludeProbes += 1;
    const excludeOnly = withProbedValue(defaults, key, {
      include: [],
      exclude: [option.value],
    });
    try {
      const { requests } = await withTimeout(
        withRequestCapture(() =>
          plugin.popularNovels(1, { filters: excludeOnly }),
        ),
        STEP_TIMEOUT_MS,
        `popularNovels(${key} exclude ${option.label})`,
      );
      if (requestSignature(requests) === defaultSignature) {
        failures.push(
          `"${key}" exclude-only selection sent the same request as the default filters (exclude is read nowhere)`,
        );
      }
    } catch (error) {
      const net = isNetworkOrBlockError(error);
      if (net.inconclusive) {
        excludeStep.status = 'INCONCLUSIVE';
        excludeStep.detail = net.reason || error.message;
        return steps;
      }
      failures.push(`"${key}" exclude-only selection threw: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    matrixStep.status = 'FAIL';
    matrixStep.detail = failures.slice(0, 3).join('; ');
  } else {
    matrixStep.status = 'PASS';
    matrixStep.detail = `${probed.length} non-default filter value(s) changed the request`;
  }

  if (excludableKeys.length === 0) {
    excludeStep.status = 'PASS';
    excludeStep.detail = 'No ExcludableCheckboxGroup filters declared';
  } else if (failures.some(f => f.includes('exclude'))) {
    excludeStep.status = 'FAIL';
    excludeStep.detail = failures
      .filter(f => f.includes('exclude'))
      .slice(0, 2)
      .join('; ');
  } else if (excludeStep.status !== 'INCONCLUSIVE') {
    excludeStep.status = 'PASS';
    excludeStep.detail = `${excludeProbes} exclude selection(s) changed the request`;
  }

  return steps;
}

async function runChecks(plugin) {
  const steps = [];
  const filters = defaultFilterValues(plugin);

  // 0. Offline filter-schema checks. Before any network call so they still
  // report when the site is down or blocking the runner.
  const integrityStep = checkFilterSchema(plugin);
  if (integrityStep) steps.push(integrityStep);

  // 1. popularNovels
  const popularStep = makeStep('popularNovels');
  steps.push(popularStep);
  let popular;
  let defaultRequests = [];
  try {
    const captured = await withTimeout(
      withRequestCapture(() => plugin.popularNovels(1, { filters })),
      STEP_TIMEOUT_MS,
      'popularNovels',
    );
    popular = captured.value;
    defaultRequests = captured.requests;
    if (!Array.isArray(popular) || popular.length === 0) {
      popularStep.status = 'FAIL';
      popularStep.detail = 'Returned no novels';
      return steps;
    }
    popularStep.status = 'PASS';
    popularStep.detail = `${popular.length} novels`;
  } catch (error) {
    const net = isNetworkOrBlockError(error);
    popularStep.status = net.inconclusive ? 'INCONCLUSIVE' : 'FAIL';
    popularStep.detail = net.reason || error.message;
    return steps;
  }

  // 2. Non-default filter values. Runs as soon as the default call succeeded so
  // a later parseNovel/parseChapter failure cannot hide a filter that is not
  // wired up.
  steps.push(...(await runFilterMatrix(plugin, filters, defaultRequests)));

  const firstNovel = popular[0];

  // 2. searchNovels
  const searchStep = makeStep('searchNovels');
  steps.push(searchStep);
  try {
    const results = await withTimeout(
      plugin.searchNovels(firstNovel.name, 1),
      STEP_TIMEOUT_MS,
      'searchNovels',
    );
    if (!Array.isArray(results)) {
      searchStep.status = 'FAIL';
      searchStep.detail = 'Did not return an array';
    } else {
      searchStep.status = 'PASS';
      searchStep.detail = `${results.length} results for "${firstNovel.name}"`;
    }
  } catch (error) {
    const net = isNetworkOrBlockError(error);
    searchStep.status = net.inconclusive ? 'INCONCLUSIVE' : 'FAIL';
    searchStep.detail = net.reason || error.message;
  }

  // 3. parseNovel
  const parseNovelStep = makeStep('parseNovel');
  steps.push(parseNovelStep);
  let novel;
  try {
    novel = await withTimeout(
      plugin.parseNovel(firstNovel.path),
      STEP_TIMEOUT_MS,
      'parseNovel',
    );
    const isPagePlugin = typeof plugin.parsePage === 'function';
    let chapters = novel?.chapters;
    if (isPagePlugin && (!chapters || chapters.length === 0)) {
      const page = await withTimeout(
        plugin.parsePage(firstNovel.path, '1'),
        STEP_TIMEOUT_MS,
        'parsePage',
      );
      chapters = page?.chapters;
    }
    if (!novel?.name || !chapters || chapters.length === 0) {
      parseNovelStep.status = 'FAIL';
      parseNovelStep.detail = !novel?.name
        ? 'Missing novel name'
        : 'No chapters returned';
      return steps;
    }
    // cover is required; the other metadata fields are legitimately absent on
    // many sites, so they are reported but do not fail the check.
    //
    // Note: chapter releaseTime is deliberately not asserted. Plugins read dayjs
    // from the runtime (the app injects its own instance via
    // src/plugins/pluginManager.ts with localizedFormat already extended), so a
    // token like 'LLL' is correct in the app even though this harness bundles
    // its own unconfigured copy of dayjs and therefore sees the literal token.
    const metadata = ['author', 'genres', 'status', 'summary'];
    const absent = metadata.filter(field => {
      const value = novel[field];
      return typeof value !== 'string' || value.trim() === '';
    });
    if (!novel.cover || String(novel.cover).trim() === '') {
      parseNovelStep.status = 'FAIL';
      parseNovelStep.detail = 'Missing cover';
      return steps;
    }
    parseNovelStep.status = 'PASS';
    parseNovelStep.detail = `${chapters.length} chapters; cover ✓${
      absent.length > 0
        ? `; absent: ${absent.join(', ')}`
        : '; author/genres/status/summary ✓'
    }`;
    novel = { ...novel, chapters };
  } catch (error) {
    const net = isNetworkOrBlockError(error);
    parseNovelStep.status = net.inconclusive ? 'INCONCLUSIVE' : 'FAIL';
    parseNovelStep.detail = net.reason || error.message;
    return steps;
  }

  // 4. parseChapter
  const parseChapterStep = makeStep('parseChapter');
  steps.push(parseChapterStep);
  try {
    const firstChapter = novel.chapters[0];
    const content = await withTimeout(
      plugin.parseChapter(firstChapter.path),
      STEP_TIMEOUT_MS,
      'parseChapter',
    );
    const length = typeof content === 'string' ? content.trim().length : 0;
    if (length < MIN_CHAPTER_LENGTH) {
      parseChapterStep.status = 'FAIL';
      parseChapterStep.detail = `Content too short (${length} chars, expected >= ${MIN_CHAPTER_LENGTH})`;
    } else {
      parseChapterStep.status = 'PASS';
      parseChapterStep.detail = `${length} chars`;
    }
  } catch (error) {
    const net = isNetworkOrBlockError(error);
    parseChapterStep.status = net.inconclusive ? 'INCONCLUSIVE' : 'FAIL';
    parseChapterStep.detail = net.reason || error.message;
  }

  return steps;
}

/**
 * fetchText/fetchFile in this repo swallow network and non-2xx errors and
 * resolve to '' instead of throwing (see src/lib/fetch.ts), so a plugin using
 * them will surface a site-down/anti-bot block as an empty result, not an
 * exception — which runChecks() would otherwise misreport as a FAIL. Probe
 * the plugin's base site directly first so a known-bad site short-circuits
 * to INCONCLUSIVE before running the real checks, using the same Cloudflare
 * header heuristic as scripts/check-plugin-sites.js.
 */
async function probeSiteReachability(site) {
  try {
    const res = await withTimeout(
      fetch(site, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 live-check-plugin' },
      }),
      STEP_TIMEOUT_MS,
      'site probe',
    );
    if (res.status >= 200 && res.status < 400) {
      // A cf-ray/cf-cache-status header here just means the site is fronted
      // by Cloudflare's CDN, which is true of a huge share of the web and
      // says nothing about whether we were blocked — only a 403/503 does.
      return { reachable: true };
    }
    const isCloudflare = CLOUDFLARE_HEADER_HINTS.some(h => res.headers.has(h));
    if (res.status === 403 || res.status === 503) {
      return {
        reachable: false,
        reason: `HTTP ${res.status}${isCloudflare ? ' (Cloudflare)' : ''}`,
      };
    }
    return { reachable: false, reason: `HTTP ${res.status}` };
  } catch (error) {
    const net = isNetworkOrBlockError(error);
    return { reachable: false, reason: net.reason || error.message };
  }
}

async function checkPlugin(pluginPath) {
  const result = { pluginPath, steps: [], loadError: null };
  let plugin;
  try {
    plugin = await loadPluginInstance(pluginPath);
  } catch (error) {
    result.loadError = error.message;
    return result;
  }

  const probe = await probeSiteReachability(plugin.site);
  if (!probe.reachable) {
    const step = makeStep('siteReachability');
    step.status = 'INCONCLUSIVE';
    step.detail = probe.reason;
    result.steps = [step];
    return result;
  }

  result.steps = await runChecks(plugin);
  return result;
}

function escapeMarkdown(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');
}

function printReport(results) {
  let hasFail = false;
  let hasInconclusive = false;

  console.log('## Plugin Live Check');

  for (const result of results) {
    console.log(`\n### \`${escapeMarkdown(result.pluginPath)}\``);
    console.log('\n| Check | Result | Details |');
    console.log('| --- | --- | --- |');

    if (result.loadError) {
      hasFail = true;
      console.log(
        `| \`bundle/load\` | ❌ FAIL | ${escapeMarkdown(result.loadError)} |`,
      );
      continue;
    }

    for (const step of result.steps) {
      const resultLabel =
        step.status === 'PASS'
          ? '✅ PASS'
          : step.status === 'FAIL'
            ? '❌ FAIL'
            : '⚠️ INCONCLUSIVE';
      console.log(
        `| \`${escapeMarkdown(step.name)}\` | ${resultLabel} | ${escapeMarkdown(step.detail)} |`,
      );
      if (step.status === 'FAIL') hasFail = true;
      if (step.status === 'INCONCLUSIVE') hasInconclusive = true;
    }
  }

  console.log(
    hasFail
      ? '\n**Result: ❌ Failed — at least one check failed.**'
      : hasInconclusive
        ? '\n**Result: ⚠️ Inconclusive — no hard failures.**'
        : '\n**Result: ✅ Passed — all checks succeeded.**',
  );
  return hasFail;
}

async function main() {
  const pluginPaths = process.argv.slice(2);
  if (pluginPaths.length === 0) {
    console.error(
      'Usage: node scripts/live-check-plugin.mjs <plugin.ts> [more.ts...]',
    );
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (const pluginPath of pluginPaths) {
    results.push(await checkPlugin(pluginPath));
  }

  const hasFail = printReport(results);
  // Set exitCode rather than calling process.exit(): fetch's keep-alive
  // sockets can still be mid-close here, and an abrupt exit() while libuv
  // has a handle in that state crashes the process on Windows.
  process.exitCode = hasFail ? 1 : 0;
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});

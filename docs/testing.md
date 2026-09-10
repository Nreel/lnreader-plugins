# Testing your plugin

`tsc`, ESLint, and Prettier all check that your plugin _compiles_. None of them can tell you
whether it actually returns novels, chapters, or search results from the real site — plugins fail
in ways the compiler can't see, because the wiki/site content they scrape has no schema: an empty
chapter list, a chapter body that's actually a "back to top" nav page, search results leaking
pages in the wrong language, and so on.

## `npm run check:plugin`

Bundles your plugin with esbuild the same way the production build does, then runs it against the
live site — calling `popularNovels`, `searchNovels`, `parseNovel`, and `parseChapter` in sequence,
using your plugin's own default filter values (the same values the app would send).

```sh
npm run check:plugin -- plugins/english/yourPlugin.ts
```

You can check multiple plugins in one run:

```sh
npm run check:plugin -- plugins/english/yourPlugin.ts plugins/english/anotherPlugin.ts
```

Each step reports one of three outcomes:

- **PASS** — got a plausible result (non-empty novel list, a chapter body over ~200 characters,
  etc).
- **FAIL** — the plugin ran but returned something wrong (empty results, a novel with no chapters,
  a suspiciously short chapter body, or a thrown error that isn't network-related). This is what
  you're looking for before opening a PR.
- **INCONCLUSIVE** — the site itself was unreachable, timed out, or returned a Cloudflare-style
  block during this run. Not a plugin bug; re-run later or check the site manually.

### Filter steps

Three of the steps exist because a plugin's defaults exercise almost none of its filter code — the
default filter values are usually all-empty, so a filter that is declared but never read still
looks fine:

- `filterIntegrity` — offline checks on the filter definitions (runs before any network call, so it
  still reports when the site is down): options must exist where the filter type requires them,
  every option needs a non-empty label and a value, and each filter's declared default value must
  match its type. An empty value (`''`) is allowed — that is how a Picker spells "Any". Duplicate
  values within one filter are reported in the step detail but do not fail the run.
- `filterMatrix` — sends a few **non-default** values, taken from your own `options` in declaration
  order, and fails if any of them produces the exact same outgoing request as the default run. That
  is the signature of a filter that is displayed but never applied. At most 3 options per filter are
  probed, so a filter declaring hundreds of options does not turn one check into hundreds of
  requests; this means the default run is a sample, **not** a full sweep of every value.
- `filterExcludeHandling` — for `ExcludableCheckboxGroup` filters only: selects `exclude` with no
  `include` and requires the outgoing request to change. If your plugin declares an excludable group
  but only reads `.value.include`, this fails — either read `.value.exclude` or declare a plain
  `CheckboxGroup`.

Requests are observed by wrapping the global `fetch` for the duration of each call; no test doubles
are required in the plugin.

A full per-option sweep is deliberately **not** part of the default run: a plugin with hundreds of
options would fire hundreds of live requests at the target site on every PR. If you want that for a
single plugin, probe the values you care about by hand in the playground instead.

## CI

Any PR that touches a file under `plugins/**/*.ts` (excluding multisrc-generated files) runs this
same check automatically against just the changed plugins, and posts the results as a job summary
on the workflow run (visible from the PR's checks list, under the Actions tab) — not as a PR
comment. The check only fails the PR on a genuine `FAIL` — `INCONCLUSIVE` results (a site being
briefly down) never block a merge.

You can also trigger it manually against any plugin path from the Actions tab
(`Plugin Live Check` → `Run workflow`), which is useful for re-checking an existing plugin after
its target site changes layout.

## See also

`check:plugin` catches wrong/missing data automatically, but it's not a substitute for actually
looking at the output. See the [website tutorial](./website-tutorial.md) for testing your plugin
interactively in the browser — useful for spot-checking filters, pagination, and chapter
formatting by eye before opening a PR.

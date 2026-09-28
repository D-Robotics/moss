/**
 * Thin re-export shell for the `web_search` tool modules in `web-search/`.
 * Kept at the original path so consumers importing `dist/tools/web-search.js`
 * (src/index.ts, src/tools/builtin.ts, src/cli-main.ts, and the web-search /
 * steering specs) keep working unchanged. The exported surface is exactly the
 * historical surface of this former single-file module.
 */

export * from './web-search/index.js';

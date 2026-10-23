/**
 * Extension entry point.
 *
 * The host resolves a configured extension *directory* to `index.ts` (or a
 * one-level scan of `.ts` files) and imports the default export as the factory,
 * so this file only re-exports the implementation under `src/`.
 *
 *   omp --extension .
 *   pi  --extension .
 */

export { default } from "./src/index.ts";

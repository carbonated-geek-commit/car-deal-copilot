/**
 * Process entry point.
 *
 * `start.ts` exports `main()` and deliberately does not call it — that is what
 * makes every startup branch testable without spawning a process or mutating a
 * global. The consequence is that `start.ts` alone is not runnable: executing
 * it defines `main` and exits 0 having served nothing.
 *
 * This file is the one place that actually invokes it, so `npm run dev` has
 * something to point at.
 */
import { main } from './start.js';

await main();

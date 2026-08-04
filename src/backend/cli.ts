/**
 * Bundle entry point for `buzz-backend-autogent`.
 *
 * Kept separate from `main.ts` so the request handler stays importable by tests
 * without executing anything, and so the bundler has exactly one module that
 * has side effects.
 *
 * No shebang here: the bundler adds one as a banner, and a second copy inside
 * the module body is a syntax error once the file is executed directly.
 */

import { main } from "./main.js";

void main();

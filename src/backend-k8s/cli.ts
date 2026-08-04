/**
 * Bundle entry point for `buzz-backend-autogent-k8s`.
 *
 * Kept separate from `main.ts` so the request handler stays importable by
 * tests without executing anything (same pattern as the local provider).
 */

import { main } from "./main.js";

void main();

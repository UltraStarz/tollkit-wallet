/**
 * Stands in for paid-tools.ts in the iPhone app (tollkit-mobile/build.mjs --ios): the in-app chat there has no paid
 * tools, so nothing is registered and its instructions say it makes no payments.
 */
export const PAID_PROMPT_LINE = "";
export const PAID_PROMPT_CLAUSE = ", you make no payments,";
export function registerPaidTools(_s: unknown, _w: unknown) { /* none in this build */ }

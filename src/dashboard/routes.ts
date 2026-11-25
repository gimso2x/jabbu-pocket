/**
 * Path patterns of the dashboard server. A tunnel may mount the dashboard under a prefix (`/task/…`); every API route
 * matches with or without one. The page itself is `/` or a one-segment prefix only, and never `/api/` or `/healthz/`:
 * any other path ending in `/` is a 404.
 */
export const PAGE = /^\/(?:(?!(?:api|healthz)\/)[^/]+\/)?$/;
export const SNAPSHOT = /^\/(?:.*\/)?api\/snapshot$/;
export const HEALTH = /^\/(?:.*\/)?healthz$/;
export const BOARD = /^\/(?:.*\/)?api\/board$/;
export const BOARD_EVENTS = /^\/(?:.*\/)?api\/board\/events$/;
export const PANE = /^\/(?:.*\/)?api\/pane\/(conversation|plan|trace)$/;
export const JOB_TRACE = /^\/(?:.*\/)?api\/job\/trace$/;
export const TRACE = /^\/(?:.*\/)?api\/turn\/(\d{1,15})\/trace$/;
export const THREAD_CONVERSATION = /^\/(?:.*\/)?api\/thread\/conversation$/;
export const MONITOR_DETAIL = /^\/(?:.*\/)?api\/monitor\/detail$/;
export const DIFF = /^\/(?:.*\/)?api\/diff$/;
export const THREAD_LIVE = /^\/(?:.*\/)?api\/thread\/live$/;
export const THREAD_LIVE_EVENTS = /^\/(?:.*\/)?api\/thread\/live\/events$/;
export const MANIFEST = /^\/(?:.*\/)?manifest\.webmanifest$/;
export const ICON = /^\/(?:.*\/)?icons\/(icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png$/;
export const WEB_ANY = /^\/(?:.*\/)?api\/web(?:\/.*)?$/;
export const WEB_CONVERSATIONS = /^\/(?:.*\/)?api\/web\/conversations$/;
export const WEB_MESSAGES = /^\/(?:.*\/)?api\/web\/messages$/;
export const WEB_STREAM = /^\/(?:.*\/)?api\/web\/stream$/;
export const WEB_SEND = /^\/(?:.*\/)?api\/web\/send$/;
export const WEB_ACTION = /^\/(?:.*\/)?api\/web\/action$/;
export const WEB_NEW = /^\/(?:.*\/)?api\/web\/new$/;
export const WEB_UPLOAD = /^\/(?:.*\/)?api\/web\/upload$/;
export const WEB_FILE = /^\/(?:.*\/)?api\/web\/file$/;

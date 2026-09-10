/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authRoles from "../authRoles.js";
import type * as boolbackPresets from "../boolbackPresets.js";
import type * as brews from "../brews.js";
import type * as canvas from "../canvas.js";
import type * as claudeSessions from "../claudeSessions.js";
import type * as crons from "../crons.js";
import type * as forge from "../forge.js";
import type * as gpuPool from "../gpuPool.js";
import type * as http from "../http.js";
import type * as serverHealth from "../serverHealth.js";
import type * as symbolScores from "../symbolScores.js";
import type * as tts from "../tts.js";
import type * as ttsAsk from "../ttsAsk.js";
import type * as ttsCalendar from "../ttsCalendar.js";
import type * as ttsCalendarExpand from "../ttsCalendarExpand.js";
import type * as ttsCalendarFetch from "../ttsCalendarFetch.js";
import type * as ttsCalendarWrite from "../ttsCalendarWrite.js";
import type * as ttsCanvas from "../ttsCanvas.js";
import type * as ttsCode from "../ttsCode.js";
import type * as ttsCompose from "../ttsCompose.js";
import type * as ttsContext from "../ttsContext.js";
import type * as ttsDigest from "../ttsDigest.js";
import type * as ttsEvals from "../ttsEvals.js";
import type * as ttsHourly from "../ttsHourly.js";
import type * as ttsIntegrations from "../ttsIntegrations.js";
import type * as ttsJobs from "../ttsJobs.js";
import type * as ttsMerge from "../ttsMerge.js";
import type * as ttsMigrations from "../ttsMigrations.js";
import type * as ttsNightly from "../ttsNightly.js";
import type * as ttsRepeats from "../ttsRepeats.js";
import type * as ttsRulings from "../ttsRulings.js";
import type * as ttsSearch from "../ttsSearch.js";
import type * as ttsShared from "../ttsShared.js";
import type * as ttsSkills from "../ttsSkills.js";
import type * as ttsSlack from "../ttsSlack.js";
import type * as ttsSlackDrafts from "../ttsSlackDrafts.js";
import type * as ttsSync from "../ttsSync.js";
import type * as ttsWeekly from "../ttsWeekly.js";
import type * as users from "../users.js";
import type * as userSettings from "../userSettings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authRoles: typeof authRoles;
  boolbackPresets: typeof boolbackPresets;
  brews: typeof brews;
  canvas: typeof canvas;
  claudeSessions: typeof claudeSessions;
  crons: typeof crons;
  forge: typeof forge;
  gpuPool: typeof gpuPool;
  http: typeof http;
  serverHealth: typeof serverHealth;
  symbolScores: typeof symbolScores;
  tts: typeof tts;
  ttsAsk: typeof ttsAsk;
  ttsCalendar: typeof ttsCalendar;
  ttsCalendarExpand: typeof ttsCalendarExpand;
  ttsCalendarFetch: typeof ttsCalendarFetch;
  ttsCalendarWrite: typeof ttsCalendarWrite;
  ttsCanvas: typeof ttsCanvas;
  ttsCode: typeof ttsCode;
  ttsCompose: typeof ttsCompose;
  ttsContext: typeof ttsContext;
  ttsDigest: typeof ttsDigest;
  ttsEvals: typeof ttsEvals;
  ttsHourly: typeof ttsHourly;
  ttsIntegrations: typeof ttsIntegrations;
  ttsJobs: typeof ttsJobs;
  ttsMerge: typeof ttsMerge;
  ttsMigrations: typeof ttsMigrations;
  ttsNightly: typeof ttsNightly;
  ttsRepeats: typeof ttsRepeats;
  ttsRulings: typeof ttsRulings;
  ttsSearch: typeof ttsSearch;
  ttsShared: typeof ttsShared;
  ttsSkills: typeof ttsSkills;
  ttsSlack: typeof ttsSlack;
  ttsSlackDrafts: typeof ttsSlackDrafts;
  ttsSync: typeof ttsSync;
  ttsWeekly: typeof ttsWeekly;
  users: typeof users;
  userSettings: typeof userSettings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

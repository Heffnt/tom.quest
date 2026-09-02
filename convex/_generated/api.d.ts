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
import type * as perfumeTestSeed from "../perfumeTestSeed.js";
import type * as serverHealth from "../serverHealth.js";
import type * as symbolScores from "../symbolScores.js";
import type * as tts from "../tts.js";
import type * as ttsCalendar from "../ttsCalendar.js";
import type * as ttsCalendarExpand from "../ttsCalendarExpand.js";
import type * as ttsCalendarFetch from "../ttsCalendarFetch.js";
import type * as ttsCalendarWrite from "../ttsCalendarWrite.js";
import type * as ttsCanvas from "../ttsCanvas.js";
import type * as ttsCode from "../ttsCode.js";
import type * as ttsRepeats from "../ttsRepeats.js";
import type * as ttsRulings from "../ttsRulings.js";
import type * as ttsShared from "../ttsShared.js";
import type * as ttsSkills from "../ttsSkills.js";
import type * as ttsSync from "../ttsSync.js";
import type * as userSettings from "../userSettings.js";
import type * as users from "../users.js";

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
  perfumeTestSeed: typeof perfumeTestSeed;
  serverHealth: typeof serverHealth;
  symbolScores: typeof symbolScores;
  tts: typeof tts;
  ttsCalendar: typeof ttsCalendar;
  ttsCalendarExpand: typeof ttsCalendarExpand;
  ttsCalendarFetch: typeof ttsCalendarFetch;
  ttsCalendarWrite: typeof ttsCalendarWrite;
  ttsCanvas: typeof ttsCanvas;
  ttsCode: typeof ttsCode;
  ttsRepeats: typeof ttsRepeats;
  ttsRulings: typeof ttsRulings;
  ttsShared: typeof ttsShared;
  ttsSkills: typeof ttsSkills;
  ttsSync: typeof ttsSync;
  userSettings: typeof userSettings;
  users: typeof users;
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

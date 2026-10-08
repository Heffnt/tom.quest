/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentLabels from "../agentLabels.js";
import type * as agentSurfaces from "../agentSurfaces.js";
import type * as agents from "../agents.js";
import type * as auth from "../auth.js";
import type * as authRoles from "../authRoles.js";
import type * as boolbackPresets from "../boolbackPresets.js";
import type * as boxChanges from "../boxChanges.js";
import type * as brews from "../brews.js";
import type * as canvas from "../canvas.js";
import type * as claudeSessions from "../claudeSessions.js";
import type * as crons from "../crons.js";
import type * as dayLog from "../dayLog.js";
import type * as dayLogVocabulary from "../dayLogVocabulary.js";
import type * as forge from "../forge.js";
import type * as gateLandings from "../gateLandings.js";
import type * as history from "../history.js";
import type * as historyRows from "../historyRows.js";
import type * as http from "../http.js";
import type * as intent from "../intent.js";
import type * as intentParse from "../intentParse.js";
import type * as jarvis_auth from "../jarvis/auth.js";
import type * as jarvis_build from "../jarvis/build.js";
import type * as jarvis_changes from "../jarvis/changes.js";
import type * as jarvis_context from "../jarvis/context.js";
import type * as jarvis_design from "../jarvis/design.js";
import type * as jarvis_digest from "../jarvis/digest.js";
import type * as jarvis_events from "../jarvis/events.js";
import type * as jarvis_intent from "../jarvis/intent.js";
import type * as jarvis_jobs from "../jarvis/jobs.js";
import type * as jarvis_outbox from "../jarvis/outbox.js";
import type * as jarvis_partStates from "../jarvis/partStates.js";
import type * as jarvis_record from "../jarvis/record.js";
import type * as jarvis_routes from "../jarvis/routes.js";
import type * as jarvis_rulings from "../jarvis/rulings.js";
import type * as jarvis_tables from "../jarvis/tables.js";
import type * as jarvis_tick from "../jarvis/tick.js";
import type * as jarvis_todos from "../jarvis/todos.js";
import type * as observeMerge from "../observeMerge.js";
import type * as push from "../push.js";
import type * as pushSend from "../pushSend.js";
import type * as readBudget from "../readBudget.js";
import type * as secrets from "../secrets.js";
import type * as serverHealth from "../serverHealth.js";
import type * as sessionRegistration from "../sessionRegistration.js";
import type * as sessionRows from "../sessionRows.js";
import type * as symbolScores from "../symbolScores.js";
import type * as trainingDay from "../trainingDay.js";
import type * as tts from "../tts.js";
import type * as ttsAsk from "../ttsAsk.js";
import type * as ttsCalendarWrite from "../ttsCalendarWrite.js";
import type * as ttsCanvas from "../ttsCanvas.js";
import type * as ttsCode from "../ttsCode.js";
import type * as ttsCompose from "../ttsCompose.js";
import type * as ttsContext from "../ttsContext.js";
import type * as ttsDigest from "../ttsDigest.js";
import type * as ttsEvals from "../ttsEvals.js";
import type * as ttsIntegrations from "../ttsIntegrations.js";
import type * as ttsJobs from "../ttsJobs.js";
import type * as ttsMerge from "../ttsMerge.js";
import type * as ttsMigrations from "../ttsMigrations.js";
import type * as ttsNightly from "../ttsNightly.js";
import type * as ttsRulings from "../ttsRulings.js";
import type * as ttsSearch from "../ttsSearch.js";
import type * as ttsShared from "../ttsShared.js";
import type * as ttsSignoff from "../ttsSignoff.js";
import type * as ttsSimplify from "../ttsSimplify.js";
import type * as ttsSkills from "../ttsSkills.js";
import type * as ttsSlack from "../ttsSlack.js";
import type * as ttsSync from "../ttsSync.js";
import type * as ttsWeekly from "../ttsWeekly.js";
import type * as userSettings from "../userSettings.js";
import type * as users from "../users.js";
import type * as vocabulary from "../vocabulary.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentLabels: typeof agentLabels;
  agentSurfaces: typeof agentSurfaces;
  agents: typeof agents;
  auth: typeof auth;
  authRoles: typeof authRoles;
  boolbackPresets: typeof boolbackPresets;
  boxChanges: typeof boxChanges;
  brews: typeof brews;
  canvas: typeof canvas;
  claudeSessions: typeof claudeSessions;
  crons: typeof crons;
  dayLog: typeof dayLog;
  dayLogVocabulary: typeof dayLogVocabulary;
  forge: typeof forge;
  gateLandings: typeof gateLandings;
  history: typeof history;
  historyRows: typeof historyRows;
  http: typeof http;
  intent: typeof intent;
  intentParse: typeof intentParse;
  "jarvis/auth": typeof jarvis_auth;
  "jarvis/build": typeof jarvis_build;
  "jarvis/changes": typeof jarvis_changes;
  "jarvis/context": typeof jarvis_context;
  "jarvis/design": typeof jarvis_design;
  "jarvis/digest": typeof jarvis_digest;
  "jarvis/events": typeof jarvis_events;
  "jarvis/intent": typeof jarvis_intent;
  "jarvis/jobs": typeof jarvis_jobs;
  "jarvis/outbox": typeof jarvis_outbox;
  "jarvis/partStates": typeof jarvis_partStates;
  "jarvis/record": typeof jarvis_record;
  "jarvis/routes": typeof jarvis_routes;
  "jarvis/rulings": typeof jarvis_rulings;
  "jarvis/tables": typeof jarvis_tables;
  "jarvis/tick": typeof jarvis_tick;
  "jarvis/todos": typeof jarvis_todos;
  observeMerge: typeof observeMerge;
  push: typeof push;
  pushSend: typeof pushSend;
  readBudget: typeof readBudget;
  secrets: typeof secrets;
  serverHealth: typeof serverHealth;
  sessionRegistration: typeof sessionRegistration;
  sessionRows: typeof sessionRows;
  symbolScores: typeof symbolScores;
  trainingDay: typeof trainingDay;
  tts: typeof tts;
  ttsAsk: typeof ttsAsk;
  ttsCalendarWrite: typeof ttsCalendarWrite;
  ttsCanvas: typeof ttsCanvas;
  ttsCode: typeof ttsCode;
  ttsCompose: typeof ttsCompose;
  ttsContext: typeof ttsContext;
  ttsDigest: typeof ttsDigest;
  ttsEvals: typeof ttsEvals;
  ttsIntegrations: typeof ttsIntegrations;
  ttsJobs: typeof ttsJobs;
  ttsMerge: typeof ttsMerge;
  ttsMigrations: typeof ttsMigrations;
  ttsNightly: typeof ttsNightly;
  ttsRulings: typeof ttsRulings;
  ttsSearch: typeof ttsSearch;
  ttsShared: typeof ttsShared;
  ttsSignoff: typeof ttsSignoff;
  ttsSimplify: typeof ttsSimplify;
  ttsSkills: typeof ttsSkills;
  ttsSlack: typeof ttsSlack;
  ttsSync: typeof ttsSync;
  ttsWeekly: typeof ttsWeekly;
  userSettings: typeof userSettings;
  users: typeof users;
  vocabulary: typeof vocabulary;
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

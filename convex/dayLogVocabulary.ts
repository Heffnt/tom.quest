// One bounded vocabulary is sent to the worker and used again at write-back.
// The worker can propose only values the server names here.

export const DAY_LOG_TYPES = ["measurement", "workout", "food", "feeling", "symptom", "work"] as const;
export const DAY_LOG_PARTS_OF_DAY = ["morning", "afternoon", "evening", "unknown"] as const;
export const DAY_LOG_ACTIVITIES = ["run", "climb", "strength", "bike", "walk", "other"] as const;
export const DAY_LOG_BODY_PARTS = ["fingers", "forearms", "biceps", "back", "shoulders", "chest", "triceps", "core", "hips", "quads", "hamstrings", "calves", "ankles", "full-body"] as const;

export const DAY_LOG_METRICS = {
  weight: { unit: "lb", min: 60, max: 600 },
  waist: { unit: "in", min: 20, max: 70 },
  pullup_added_weight: { unit: "lb", min: 0, max: 200 },
  hang_20mm: { unit: "s", min: 1, max: 300 },
  sprint_40yd: { unit: "s", min: 3, max: 20 },
  loop_1_4mi: { unit: "s", min: 300, max: 2400 },
} as const;

export const DAY_LOG_BOUNDS = {
  maxItems: 20,
  summaryMax: 120,
  quoteMax: 300,
  maxDaysBack: 7,
  bodyPartsMax: 6,
} as const;

export const DAY_LOG_VOCABULARY = {
  types: [...DAY_LOG_TYPES],
  metrics: DAY_LOG_METRICS,
  partsOfDay: [...DAY_LOG_PARTS_OF_DAY],
  activities: [...DAY_LOG_ACTIVITIES],
  bodyParts: [...DAY_LOG_BODY_PARTS],
  bounds: DAY_LOG_BOUNDS,
} as const;

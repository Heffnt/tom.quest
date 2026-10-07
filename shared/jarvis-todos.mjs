// jarvis-todos.mjs — what a todo write from the box holds, checked the same
// way on both sides of the network.
//
// A todo is one row (design of 2026-10-06, sections 7 and 12.2): his text as
// he said it, an optional due time, an optional reminder time, done or not.
// The persistent sessions that hold the list (todo, and dump when he states
// one there) write it from the box with `jarvis write todo` (Jarvis
// worker/cli/write.mjs), which runs these checks before the network; the
// record's routes (convex/jarvis/todos.ts) run the same checks again, so a
// row the box refuses is a row the record would refuse, for the same reason.
//
// The fields map onto the todos table's own names (convex/schema.ts):
//   statement   his words, stored exactly as given, never trimmed or rephrased.
//   dueAt       the due time, epoch milliseconds.
//   reminderAt  the time he asked to be reminded, epoch milliseconds.
//   writeId     the write's own id: the same on every post of one todo, so a
//               resend after a lost answer is answered with the row already
//               written instead of a second row.
// Done is status "done" (with doneAt), written by the done route.

/** The longest statement a todo holds; his todos are a sentence or two. */
export const TODO_STATEMENT_MAX = 2000;
/** The statuses that are open: not done and not archived. */
export const TODO_OPEN_STATUSES = ["active", "waiting"];
/** Every field a create may carry, and nothing else. */
export const TODO_CREATE_FIELDS = ["statement", "dueAt", "reminderAt", "writeId"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEpochMs(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Why a todo create's body is malformed, or null when it is well formed. */
export function todoCreateProblem(body) {
  if (!isPlainObject(body)) return "a todo is a JSON object";
  for (const field of Object.keys(body)) {
    if (!TODO_CREATE_FIELDS.includes(field)) {
      return `a todo holds only ${TODO_CREATE_FIELDS.join(", ")}; ${field} is not one of them`;
    }
  }
  const { statement, dueAt, reminderAt, writeId } = body;
  if (typeof statement !== "string" || statement.trim() === "" || statement.length > TODO_STATEMENT_MAX) {
    return `a todo names statement, his words, as a non-empty string of at most ${TODO_STATEMENT_MAX} characters`;
  }
  if (dueAt !== undefined && !isEpochMs(dueAt)) {
    return "a todo names dueAt, when given, as epoch milliseconds (a positive whole number)";
  }
  if (reminderAt !== undefined && !isEpochMs(reminderAt)) {
    return "a todo names reminderAt, when given, as epoch milliseconds (a positive whole number)";
  }
  if (writeId !== undefined && (typeof writeId !== "string" || writeId.trim() === "")) {
    return "a todo names writeId, when given, as a non-empty string";
  }
  return null;
}

/** Why a mark-done body is malformed, or null when it is well formed. */
export function todoDoneProblem(body) {
  if (!isPlainObject(body)) return "a done names its todo in a JSON object";
  for (const field of Object.keys(body)) {
    if (field !== "todo") return `a done holds only todo; ${field} is not it`;
  }
  if (typeof body.todo !== "string" || body.todo.trim() === "") {
    return "a done names todo, the todo's id, as a non-empty string";
  }
  return null;
}

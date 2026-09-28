export const DAY_LOG_ENTRY_MAX = 4_000;

export function dayLogEntryState(text) {
  const count = text.length;
  const overLimit = count > DAY_LOG_ENTRY_MAX;
  return {
    count,
    overLimit,
    canSubmit: text.trim() !== "" && !overLimit,
  };
}

// tom.quest/secrets: a paste of NAME=VALUE lines, as copied from a notes file,
// read into one secret per line. The rules mirror the box's own reader of
// /etc/tts/worker.env (envLine in Jarvis's worker/jobs/worker-env.mjs), so a
// line reads here as it will read back on the box: blank lines and lines
// starting with # are skipped, an optional leading "export " is dropped,
// whitespace around the first = is ignored, and one layer of matching single
// or double quotes comes off the value. A # later in a value is part of it,
// as is every = after the first.
//
// NO VALUE IN A REFUSAL. A refused line is reported by its line number and,
// when one could be read, its name; never its text, which may hold a secret.

// The same rule convex/secrets.ts enforces: an env-file variable name.
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

type PastedSecret = { line: number; name: string; value: string };
// `superseded`: the line's name is sent from a later line, so there is
// nothing on this one to fix.
export type RefusedLine = { line: number; name?: string; reason: string; superseded?: true };
type ParsedPaste = { secrets: PastedSecret[]; refused: RefusedLine[] };

export function parsePaste(text: string): ParsedPaste {
  const found: PastedSecret[] = [];
  const refused: RefusedLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      refused.push({ line, reason: "no = on the line" });
      return;
    }
    let name = trimmed.slice(0, eq).trim();
    if (name.startsWith("export ")) name = name.slice("export ".length).trim();
    if (!SECRET_NAME.test(name)) {
      refused.push({
        line,
        reason: "name must be upper-case letters, digits and underscores, not starting with a digit",
      });
      return;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.trim() === "") {
      refused.push({ line, name, reason: "value is empty" });
      return;
    }
    found.push({ line, name, value });
  });
  // A name given twice: the later line is sent, as the box's reader would let
  // the later line win, and the earlier one is listed back as refused.
  const lastLine = new Map(found.map((s) => [s.name, s.line]));
  const secrets: PastedSecret[] = [];
  for (const s of found) {
    if (lastLine.get(s.name) === s.line) secrets.push(s);
    else
      refused.push({
        line: s.line,
        name: s.name,
        reason: `repeated on line ${lastLine.get(s.name)}, which is sent`,
        superseded: true,
      });
  }
  refused.sort((a, b) => a.line - b.line);
  return { secrets, refused };
}

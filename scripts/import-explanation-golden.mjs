/**
// NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs says
// it too): this file is imported by its own test, and the test bundler
// rewrites an imported module by prepending an import — which lands in front
// of a shebang and fails to parse. Every caller already names the interpreter.
 * Turns the 27 mined explanation examples into golden items.
 *
 * The source is `explanation-examples.md`: 27 real ground-up explanations from
 * this laptop's session logs, each followed by Tom's own next message. His
 * reaction IS the label - twelve landed (P1-P12) and fifteen did not (N1-N15) -
 * which is the same fact an approve or revise ruling carries, arrived at from a
 * transcript instead of from the ruling table.
 *
 * The source file is passed in rather than committed: it is raw session
 * evidence, and only the derived items belong in the repo. Tom has not been
 * through them one by one yet, so every item carries `confirmedByTom: false`,
 * and the gate treats an unconfirmed item as reportable but never as a
 * regression that fails a pull request (scripts/evals-check.mjs `gate`).
 *
 * Usage:
 *   node scripts/import-explanation-golden.mjs --source path/to/explanation-examples.md
 *   node scripts/import-explanation-golden.mjs --source source.md --out evals/golden/explanations
 *   node scripts/import-explanation-golden.mjs --source source.md --dry-run
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADING = /^### (P\d+|N\d+) \u00b7 (\d{4}-\d{2}-\d{2}) \u00b7 ([^\n\u00b7]+) \u00b7 (.+)$/gm;
const REACTION = /\*\*Tom's reaction \(verbatim\):\*\*\r?\n\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)/;
const EXPLANATION = /\*\*The explanation he was reacting to \(verbatim(?:, trimmed)?\):\*\*\r?\n\r?\n(`{6,})\r?\n([\s\S]*?)\r?\n\1/;
const RULES_READ = /^\*Rules read:\*\s*(.+)$/m;
const SOURCE = /^\*Source:\*\s*(.+)$/m;

/** The number of entries the source file is known to carry. A parse that finds
 *  any other number has drifted from the file, and a silently short golden set
 *  is worse than a loud failure. */
export const EXPECTED_EXAMPLES = 27;

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a path.`);
  }
  return value;
}

/** Parse every P/N entry. The trailing "Rules read" line is that document's own
 *  editorial, so it is kept as provenance and is never the label. */
export function parseExplanationExamples(markdown, sourcePath = "explanation-examples.md") {
  const headings = [...markdown.matchAll(HEADING)];
  const entries = headings.map((match, index) => {
    const [, shortId, date, project, topic] = match;
    const end = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice((match.index ?? 0) + match[0].length, end);
    const reaction = section.match(REACTION);
    const explanation = section.match(EXPLANATION);

    if (reaction === null || explanation === null) {
      throw new Error(`${shortId} is missing its reaction or explanation block.`);
    }

    const sentence = reaction[1]
      .split(/\r?\n/)
      .filter((line) => line.startsWith(">"))
      .map((line) => line.startsWith("> ") ? line.slice(2) : line.slice(1))
      .join("\n")
      .trim();

    return {
      id: `explanation-${shortId.toLowerCase()}`,
      source: "explanation",
      job: "explanation",
      // job/category, the one partition shape (convex/ttsEvals.ts partitionOf).
      partition: `explanation/${project.trim()}`,
      label: shortId.startsWith("P") ? "landed" : "did not",
      sentence,
      confirmedByTom: false,
      ruledOn: date,
      input: {
        topic: topic.trim(),
        contextLines: [`Date: ${date}`, `Project: ${project.trim()}`],
      },
      output: { explanation: explanation[2] },
      provenance: {
        sourceFile: basename(sourcePath),
        example: shortId,
        date,
        project: project.trim(),
        rulesRead: section.match(RULES_READ)?.[1]?.trim() ?? null,
        session: section.match(SOURCE)?.[1]?.replaceAll("`", "").trim() ?? null,
      },
    };
  });

  const ids = new Set(entries.map((entry) => entry.id));
  if (entries.length !== EXPECTED_EXAMPLES || ids.size !== entries.length) {
    throw new Error(`Expected ${EXPECTED_EXAMPLES} unique P1-P12/N1-N15 entries, found ${entries.length}.`);
  }
  return entries;
}

export function writeExplanationGolden(entries, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(outDir, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }
  return entries.length;
}

function main() {
  const args = process.argv.slice(2);
  const source = optionValue(args, "--source");
  const out = optionValue(args, "--out") ?? "evals/golden/explanations";
  const dryRun = args.includes("--dry-run");
  if (source === null) {
    throw new Error("Pass --source with explanation-examples.md.");
  }

  const sourcePath = resolve(source);
  const outDir = resolve(out);
  const entries = parseExplanationExamples(readFileSync(sourcePath, "utf8"), sourcePath);
  if (!dryRun) {
    // The output directory holds nothing but this importer's stable ids, so a
    // renamed or dropped example leaves no orphan behind.
    rmSync(outDir, { recursive: true, force: true });
    writeExplanationGolden(entries, outDir);
  }
  const landed = entries.filter((entry) => entry.label === "landed").length;
  process.stdout.write(
    `${entries.length} explanation golden items (${landed} landed, ${entries.length - landed} did not) ` +
      `${dryRun ? "validated" : "written"} to ${outDir}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

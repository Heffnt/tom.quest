"use client";

// One click on any item — a task, a goal, the batch itself — opens this:
// everything known about the item, with its ground-up explanation, in one
// fixed dialog. Understanding never requires opening a session.
//
// Actions sit at the top (CLAUDE.md UI rules): where a ruling can be given —
// on the batch always, on a task or goal whose todo is rulable (lib
// isRulable) — the four verdict buttons come first, the same row the batch
// card renders (verdict-buttons.tsx).
import type { BatchGraph, GraphGoal, GraphTask } from "./batch-card";
import VerdictButtons from "./verdict-buttons";
import { groundUpTeaser, type RulingVerdict } from "../lib";

export type DetailItem =
  | { kind: "task"; batchStatement: string; task: GraphTask; waitingOn: string[] }
  | { kind: "goal"; batchStatement: string; goal: GraphGoal }
  | { kind: "batch"; graph: BatchGraph };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 text-[13px]">
      <span className="pt-0.5 text-[11px] uppercase tracking-wide text-text-faint">
        {label}
      </span>
      <span className="text-text-muted">{children}</span>
    </div>
  );
}

export default function DetailDialog({
  item,
  onClose,
  onGroundUp,
  onRule,
  error,
}: {
  item: DetailItem;
  onClose: () => void;
  onGroundUp: (title: string, content: string) => void;
  /**
   * A failure the caller is holding rather than throwing. The session verdict
   * records the ruling and THEN opens the session, and the launch hooks catch
   * their own failures into state (app/lib/use-open-todo-session.ts) — so a
   * session that did not open has no other way to be seen from in here, where
   * this overlay covers the page the caller would otherwise print it on.
   */
  error?: string | null;
  /** ttsRulings.recordRuling on the item's subject — the batch row, or the
   * task's or goal's todo — with this verdict and sentence. Absent = no
   * verdicts are offered (the mockup route). */
  onRule?: (
    item: DetailItem,
    verdict: RulingVerdict,
    sentence: string,
  ) => Promise<unknown> | void;
}) {
  const rule = onRule
    ? (verdict: RulingVerdict, sentence: string) => onRule(item, verdict, sentence)
    : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[80vh] w-[500px] max-w-full overflow-y-auto rounded-xl border border-[#3b4a66] bg-surface p-4">
        {item.kind === "task" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.task.statement}</h3>
            {rule && item.task.rulable && (
              <VerdictButtons
                subject="todo"
                statement={item.task.statement}
                error={error}
                onRule={rule}
              />
            )}
            <Row label="part of">{item.batchStatement}</Row>
            <Row label="who">
              {item.task.actor === "tom" ? <span className="text-accent">you</span> : "agents"}
            </Row>
            <Row label="status">
              {item.task.status === "done" ? "done" : item.waitingOn.length > 0 ? "blocked" : "ready"}
            </Row>
            {item.waitingOn.length > 0 && (
              <Row label="waiting on">{item.waitingOn.join(" · ")}</Row>
            )}
            {item.task.evidence !== undefined && (
              <Row label="evidence">
                {item.task.evidence.startsWith("http") ? (
                  <a
                    href={item.task.evidence}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    {item.task.evidence}
                  </a>
                ) : (
                  item.task.evidence
                )}
              </Row>
            )}
            {item.task.groundUp !== undefined && (
              <button
                type="button"
                onClick={() => onGroundUp(item.task.statement, item.task.groundUp ?? "")}
                className="mt-1 self-start text-[13px] text-accent underline underline-offset-2 hover:text-text"
              >
                ground-up explanation
              </button>
            )}
          </div>
        )}

        {item.kind === "goal" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.goal.statement}</h3>
            {rule && item.goal.rulable && (
              <VerdictButtons
                subject="todo"
                statement={item.goal.statement}
                error={error}
                onRule={rule}
              />
            )}
            <Row label="part of">{item.batchStatement}</Row>
            <Row label="kind">goal — a condition about the world this batch must make true</Row>
            {item.goal.condition !== undefined && (
              <Row label="condition">{item.goal.condition}</Row>
            )}
            <Row label="status">{item.goal.met ? "met" : "not yet met"}</Row>
            {item.goal.code !== undefined && (
              <Row label="lives in">
                {item.goal.code.repo} · {item.goal.code.externalId}
              </Row>
            )}
            {item.goal.groundUp !== undefined && (
              <button
                type="button"
                onClick={() => onGroundUp(item.goal.statement, item.goal.groundUp ?? "")}
                className="mt-1 self-start text-[13px] text-accent underline underline-offset-2 hover:text-text"
              >
                ground-up explanation
              </button>
            )}
          </div>
        )}

        {item.kind === "batch" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.graph.statement}</h3>
            {rule && (
              <VerdictButtons
                subject="batch"
                statement={item.graph.statement}
                plan={item.graph.tasks.map((t) => ({
                  text: t.statement,
                  actor: t.actor,
                  status: t.status === "done" ? ("done" as const) : ("open" as const),
                }))}
                error={error}
                onRule={rule}
              />
            )}
            {/* The teaser, not the value: an explanation is a whole HTML
                document now, and the document itself is read fullscreen. */}
            {item.graph.groundUp !== undefined && (
              <button
                type="button"
                onClick={() =>
                  onGroundUp(item.graph.statement, item.graph.groundUp ?? "")
                }
                className="self-start text-left text-[13px] text-text-muted hover:text-text"
              >
                {groundUpTeaser(item.graph.groundUp)}
              </button>
            )}
            <Row label="tasks">{item.graph.tasks.length}</Row>
            <Row label="goals">{item.graph.goals.length}</Row>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:text-text"
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}

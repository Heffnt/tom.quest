"use client";

// One click on any item — a task, a goal, the batch itself — opens this:
// everything known about the item, with its ground-up explanation, in one
// fixed dialog. Understanding never requires opening a session.
import type { BatchGraph, GraphGoal, GraphTask } from "./batch-card";

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
}: {
  item: DetailItem;
  onClose: () => void;
}) {
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
              <p className="mt-1 border-t border-border pt-2 text-[13px] text-text-muted">
                {item.task.groundUp}
              </p>
            )}
          </div>
        )}

        {item.kind === "goal" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.goal.statement}</h3>
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
              <p className="mt-1 border-t border-border pt-2 text-[13px] text-text-muted">
                {item.goal.groundUp}
              </p>
            )}
          </div>
        )}

        {item.kind === "batch" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.graph.statement}</h3>
            <p className="text-[13px] text-text-muted">{item.graph.groundUp}</p>
            <Row label="tasks">{item.graph.tasks.length}</Row>
            <Row label="goals">{item.graph.goals.length}</Row>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted"
          >
            close
          </button>
        </div>
      </div>
    </div>
  );
}

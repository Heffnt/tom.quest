"use client";

// The batch card. Collapsed = exactly three things: statement, the plan bar
// (amber = your steps, green = agents'), and the single next thing. Expanded
// reads top-down: brief → actions → for you → plan → the todos it completes.
// Every item opens a detail dialog on click; every action opens the ruling
// dialog; nothing renders inline or shifts the page.
import type { PlanStep } from "../lib";
import PlanBar, { nextStep, planProgress } from "./plan-bar";
import type { RulingVerdict } from "./ruling-dialog";
import type { DetailItem } from "./detail-dialog";

export type MemberRef = { todoId?: string; repo?: string; externalId?: string };

export type TodoLite = {
  _id: string;
  statement: string;
  brief?: string;
  entryAction?: string;
  workDescription?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  dueAt?: number;
};

export type BatchData = TodoLite & {
  members?: MemberRef[];
  plan?: PlanStep[];
};

export default function BatchCard({
  batch,
  resolveTodo,
  expanded,
  onToggle,
  onRule,
  onDetail,
  onOpenSession,
}: {
  batch: BatchData;
  resolveTodo: (id: string) => TodoLite | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRule: (verdict: RulingVerdict) => void;
  onDetail: (item: DetailItem) => void;
  onOpenSession: () => void;
}) {
  const { done, total } = planProgress(batch.plan);
  const next = nextStep(batch.plan);
  const steps = batch.plan ?? [];
  const forYou = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.actor === "tom" && s.status === "open");

  const stepDetail = (s: PlanStep): DetailItem => ({
    kind: "step",
    batchStatement: batch.statement,
    step: s,
  });
  const memberDetail = (m: MemberRef): DetailItem => {
    if (m.todoId !== undefined) {
      const t = resolveTodo(m.todoId);
      return t
        ? { kind: "todo", ...t }
        : { kind: "todo", statement: m.todoId, status: "missing" };
    }
    return { kind: "code", repo: m.repo ?? "?", externalId: m.externalId ?? "?" };
  };

  return (
    <div
      className={`rounded-lg border bg-surface ${expanded ? "border-[#2c3a52]" : "border-border"}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left"
      >
        <span className="text-[11px] text-text-faint">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] text-text">
            {batch.statement}
          </span>
          {next && (
            <span className="block truncate text-xs text-text-muted">
              next:{" "}
              <span
                className={next.actor === "tom" ? "text-accent" : "text-text-faint"}
              >
                {next.actor === "tom" ? "you" : "agents"}
              </span>{" "}
              — {next.text}
            </span>
          )}
        </span>
        {total > 0 && (
          <span className="text-right">
            <PlanBar plan={batch.plan} />
            <span className="block text-[11px] text-text-faint">
              {done} of {total} steps done
            </span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2.5">
          {batch.brief !== undefined && (
            <p className="mb-2.5 text-[13px] text-text-muted">
              {batch.brief}{" "}
              <button
                type="button"
                onClick={() =>
                  onDetail({ kind: "todo", ...batch })
                }
                className="text-accent underline underline-offset-2"
              >
                full detail
              </button>
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenSession}
              className="rounded-md border border-accent/50 bg-accent-dim px-2.5 py-1 text-xs text-accent"
            >
              open batch session
            </button>
            {(["approve", "archive", "edit"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onRule(v)}
                className="rounded-md border border-border bg-surface-alt px-2.5 py-1 text-xs text-text-muted hover:text-text"
              >
                {v}
              </button>
            ))}
          </div>

          {forYou.length > 0 && (
            <div className="mb-3 border-l-2 border-accent pl-2.5">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-accent">
                for you · {forYou.length}
              </div>
              {forYou.map(({ s, i }) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onDetail(stepDetail(s))}
                  className="block w-full truncate py-0.5 text-left text-[13px] text-text hover:text-accent"
                >
                  ○ {s.text}
                </button>
              ))}
            </div>
          )}

          <div className="mb-1 text-[11px] uppercase tracking-wide text-text-faint">
            plan
          </div>
          {steps.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onDetail(stepDetail(s))}
              className="flex w-full items-baseline gap-2 py-0.5 text-left text-[13px]"
            >
              <span
                className={s.status === "done" ? "text-success" : "text-text-faint"}
              >
                {s.status === "done" ? "✓" : "○"}
              </span>
              <span
                className={`w-10 shrink-0 text-[10px] uppercase tracking-wide ${
                  s.actor === "tom" ? "text-accent" : "text-text-faint"
                }`}
              >
                {s.actor === "tom" ? "you" : "agent"}
              </span>
              <span
                className={`truncate ${
                  s.status === "done" ? "text-text-faint" : "text-text-muted"
                }`}
              >
                {s.text}
              </span>
            </button>
          ))}

          {(batch.members ?? []).length > 0 && (
            <>
              <div className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-text-faint">
                todos this completes · {(batch.members ?? []).length}
              </div>
              {(batch.members ?? []).map((m, i) => {
                const t = m.todoId !== undefined ? resolveTodo(m.todoId) : undefined;
                const label =
                  m.todoId !== undefined
                    ? (t?.statement ?? m.todoId)
                    : `${m.repo} · ${m.externalId}`;
                const st =
                  m.todoId !== undefined ? (t?.status ?? "missing") : "code";
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onDetail(memberDetail(m))}
                    className="flex w-full items-baseline gap-2 py-0.5 text-left text-[13px]"
                  >
                    <span
                      className={`w-14 shrink-0 text-[11px] ${
                        st === "done" || st === "archived"
                          ? "text-success"
                          : "text-text-faint"
                      }`}
                    >
                      {st}
                    </span>
                    <span className="truncate text-text-muted">{label}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

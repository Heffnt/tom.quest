"use client";

// One click on any item — a plan step, a member todo, the batch itself —
// opens this. Everything known about the item, in one fixed dialog, so
// understanding never requires opening a session.
import type { PlanStep } from "../lib";
import { fmtDate } from "../lib";

export type DetailItem =
  | { kind: "step"; batchStatement: string; step: PlanStep }
  | {
      kind: "todo";
      statement: string;
      status?: string;
      brief?: string;
      entryAction?: string;
      workDescription?: string;
      createdAt?: number;
      updatedAt?: number;
      dueAt?: number;
    }
  | { kind: "code"; repo: string; externalId: string };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 text-[13px]">
      <span className="text-[11px] uppercase tracking-wide text-text-faint pt-0.5">
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
      <div className="w-[480px] max-w-full max-h-[80vh] overflow-y-auto rounded-xl border border-[#3b4a66] bg-surface p-4">
        {item.kind === "step" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.step.text}</h3>
            <Row label="part of">{item.batchStatement}</Row>
            <Row label="who">
              {item.step.actor === "tom" ? (
                <span className="text-accent">you</span>
              ) : (
                "agents"
              )}
            </Row>
            <Row label="status">
              {item.step.status}
              {item.step.doneAt !== undefined && ` · ${fmtDate(item.step.doneAt)}`}
            </Row>
            {item.step.evidence !== undefined && (
              <Row label="evidence">
                {item.step.evidence.startsWith("http") ? (
                  <a
                    href={item.step.evidence}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    {item.step.evidence}
                  </a>
                ) : (
                  item.step.evidence
                )}
              </Row>
            )}
          </div>
        )}

        {item.kind === "todo" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">{item.statement}</h3>
            {item.status !== undefined && <Row label="status">{item.status}</Row>}
            {item.brief !== undefined && <Row label="brief">{item.brief}</Row>}
            {item.entryAction !== undefined && (
              <Row label="first move">{item.entryAction}</Row>
            )}
            {item.workDescription !== undefined && (
              <Row label="the work">{item.workDescription}</Row>
            )}
            {item.dueAt !== undefined && (
              <Row label="due">{fmtDate(item.dueAt)}</Row>
            )}
            {item.createdAt !== undefined && (
              <Row label="created">{fmtDate(item.createdAt)}</Row>
            )}
            {item.updatedAt !== undefined && (
              <Row label="updated">{fmtDate(item.updatedAt)}</Row>
            )}
          </div>
        )}

        {item.kind === "code" && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[15px] font-semibold">
              {item.repo} · {item.externalId}
            </h3>
            <Row label="lives in">{item.repo}&apos;s todo file</Row>
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

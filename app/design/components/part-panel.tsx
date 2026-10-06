"use client";

// ONE PART'S PANEL: a drawer fixed to the right edge on a wide screen, the
// whole screen on a phone, so opening it moves nothing behind it. Its query
// (jarvis/design.part) is read only while it is open. Each section is left out
// when it has nothing to show.

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import Info from "@/app/jarvis/components/info";
import { displayDay, displayForm } from "@/shared/clock.mjs";

export type PartAnswer = NonNullable<FunctionReturnType<typeof api.jarvis.design.part>>;

const HEADING = "text-[10px] font-mono uppercase tracking-wide text-text-faint";
const LINK = "underline decoration-text-faint underline-offset-2 hover:text-text";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className={HEADING}>{title}</h3>
      <div className="mt-1 text-[12px] leading-snug text-text-muted">{children}</div>
    </section>
  );
}

/** The part names of one of the row's lists, each a link to its panel. */
function PartLinks({ ids, names, onSelect }: { ids: string[]; names: Record<string, string>; onSelect: (id: string) => void }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          <button type="button" className={LINK} onClick={() => onSelect(id)}>
            {names[id] ?? id}
          </button>
        </span>
      ))}
    </>
  );
}

function PartPanelBody({
  answer,
  onSelect,
}: {
  answer: PartAnswer;
  onSelect: (id: string) => void;
}) {
  const { row, names, serves, state, rulings, registry, cuts } = answer;
  const ruled = rulings.some((r) => r.standing);
  const relations = (["starts", "reads", "writes", "refuses"] as const).filter((field) => row[field].length > 0);

  return (
    <>
      <section>
        <p className="text-[12px] text-text-muted">
          {row.type} · {row.fate.type}
          {row.fate.by !== null && (
            <>
              {" by "}
              <button type="button" className={LINK} onClick={() => onSelect(row.fate.by as string)}>
                {names[row.fate.by] ?? row.fate.by}
              </button>
            </>
          )}
        </p>
        <p className="text-[12px] text-text">
          {row.designed_by === "tom" ? "you design this in session" : "governed by outcomes"}
          {!ruled && <span className="text-text-faint"> (agent-set)</span>}
        </p>
        <p className="font-mono text-[10px] text-text-faint">
          {registry.subject.slice(0, registry.subject.indexOf("@") + 8)} · {displayForm(registry.at)}
        </p>
      </section>
      {cuts.length > 0 && (
        <p className="mt-2 font-mono text-[10px] text-warning">
          read stopped at the byte budget: {cuts.map((cut) => `${cut.what} (${cut.read} read)`).join(", ")}
        </p>
      )}

      <Section title="the row">
        {row.note !== undefined && row.note !== "" && <p className="text-text">{row.note}</p>}
        <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
          {row.file !== null && (
            <>
              <dt className="text-text-faint">file</dt>
              <dd>{row.file}</dd>
            </>
          )}
          {row.schedule !== null && (
            <>
              <dt className="text-text-faint">schedule</dt>
              <dd>{row.schedule}</dd>
            </>
          )}
          {relations.map((field) => (
            <span key={field} className="contents">
              <dt className="text-text-faint">{field}</dt>
              <dd>
                <PartLinks ids={row[field]} names={names} onSelect={onSelect} />
              </dd>
            </span>
          ))}
          {row.routes.length > 0 && (
            <>
              <dt className="text-text-faint">routes</dt>
              <dd>{row.routes.join(", ")}</dd>
            </>
          )}
        </dl>
      </Section>

      {serves.length > 0 && (
        <Section title="its sentences">
          <ul className="space-y-2">
            {serves.map((item, i) => (
              <li key={i}>
                {item.form === "evidence" &&
                  (item.line === null ? (
                    <p>
                      {item.ref} <span className="text-text-faint">(not in the record)</span>
                    </p>
                  ) : item.said.length === 0 ? (
                    <p className="text-text">{item.line}</p>
                  ) : (
                    item.said.map((said, j) => (
                      <p key={j}>
                        <span className="text-text">&ldquo;{said.sentence}&rdquo;</span>{" "}
                        <span className="font-mono text-[10px] text-text-faint">
                          {said.date} · {said.source}
                        </span>
                      </p>
                    ))
                  ))}
                {item.form === "guarantee" && (
                  <p>
                    <span className="font-mono text-text">{item.label}</span> {item.line ?? <span className="text-text-faint">(not in the record)</span>}
                  </p>
                )}
                {item.form === "outcomes" && <p>outcomes: {item.outcomes.join(", ")}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="its state">
        <p className="flex items-center gap-1.5 text-[13px] text-text">
          {state.state}
          {state.partial && <span className="text-text-faint"> (partial)</span>}
          <Info call="jarvis/design.part" side="below">
            Read from the record each time: an open issue row makes it issue; Tom&apos;s no-issues row, or a use row by Tom or an agent {state.workingAfterDays} days back, makes it working; a use row by Tom or an agent within {state.inUseDays} days makes it in use; a job-ok row of its schedule or any use row makes it run; none of these, unverified.
          </Info>
        </p>
        {state.row !== null && (
          <p>
            {state.row.kind} · {displayForm(state.row.at)}
            {state.row.text !== undefined && ` · ${state.row.text}`}
            {state.row.agentId !== null && (
              <>
                {" · "}
                <a className={LINK} href={`/agents?agent=${encodeURIComponent(state.row.agentId)}`}>
                  the agent
                </a>
              </>
            )}
          </p>
        )}
        <p className="font-mono text-[10px] text-text-faint">
          in use within {state.inUseDays} days, working after {state.workingAfterDays} days (agent-set)
        </p>
      </Section>

      {"lastCleanRun" in answer.measures && answer.measures.lastCleanRun !== undefined && (
        <Section title="its last clean run">
          <p className="font-mono text-[11px]">{answer.measures.lastCleanRun === null ? "none" : displayForm(answer.measures.lastCleanRun)}</p>
        </Section>
      )}

      <Section title={`its measures (${answer.measures.windowDays} days, agent-set)`}>
        <table className="w-full font-mono text-[11px]">
          <tbody>
            {"failures" in answer.measures && answer.measures.failures !== undefined && (
              <tr>
                <td className="pr-2 align-top text-text-faint">failures</td>
                <td>
                  {answer.measures.failures.count}
                  {answer.measures.failures.partial && " partial"}
                  {answer.measures.failures.open.map((c) => (
                    <div key={c.subject}>
                      open: {c.subject} since {displayForm(c.at)}
                    </div>
                  ))}
                </td>
              </tr>
            )}
            {"cost" in answer.measures && answer.measures.cost !== undefined && (
              <tr>
                <td className="pr-2 text-text-faint">agent cost</td>
                <td>
                  ${answer.measures.cost.usd.toFixed(2)} over {answer.measures.cost.runs} runs
                  {answer.measures.cost.unpriced > 0 && `, ${answer.measures.cost.unpriced} unpriced`}
                  {answer.measures.cost.partial && " partial"}
                </td>
              </tr>
            )}
            <tr>
              <td className="pr-2 text-text-faint">last use</td>
              <td>{answer.measures.lastUse === null ? "none" : `${displayForm(answer.measures.lastUse.at)} · ${answer.measures.lastUse.what} · ${answer.measures.lastUse.by}`}</td>
            </tr>
          </tbody>
        </table>
      </Section>

      {rulings.length > 0 && (
        <Section title="your sentences">
          <ul className="mb-2 space-y-1">
            {rulings.map((r) => (
              <li key={r.id} className={r.standing ? "text-text" : "text-text-faint"}>
                {r.sentence}{" "}
                <span className="font-mono text-[10px] text-text-faint">
                  {displayDay(r.at)}
                  {!r.standing && ` · superseded${r.supersededAt === null ? "" : ` ${displayDay(r.supersededAt)}`}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

    </>
  );
}

export default function PartPanel({ id, onClose, onSelect }: { id: string; onClose: () => void; onSelect: (id: string) => void }) {
  const answer = useQuery(api.jarvis.design.part, { id });
  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-surface shadow-2xl sm:left-auto sm:w-[36rem] sm:border-l sm:border-border">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[14px] font-semibold text-text">{answer?.row.name ?? id}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:border-text-faint hover:text-text"
        >
          close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {answer === undefined ? (
          <p className="text-[12px] text-text-faint">…</p>
        ) : answer === null ? (
          <p className="text-[12px] text-text-muted">no part {id} in the deployed registry</p>
        ) : (
          <PartPanelBody
            answer={answer}
            onSelect={onSelect}
          />
        )}
      </div>
    </aside>
  );
}

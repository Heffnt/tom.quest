// FactTable — principles 2 and 7: a table of at most ten rows; more than ten
// renders ten, then a Fold holding the next ten, then "and N more". Number
// columns are right-aligned in mono. Its caption names the query.

import type { ReactNode } from "react";
import { LIST_CAP } from "./caps";
import Fold from "./fold";
import Num from "./num";
import QueryCaption from "./query-caption";

type Column = { key: string; name: string; align?: "num" };
type Row = Record<string, ReactNode>;

function Rows({ columns, rows }: { columns: readonly Column[]; rows: readonly Row[] }) {
  return (
    <>
      {rows.map((row, i) => (
        <tr key={i}>
          {columns.map((c) => (
            <td key={c.key} className={c.align === "num" ? "is-num" : undefined}>
              {row[c.key]}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function Table({
  columns,
  rows,
  total,
}: {
  columns: readonly Column[];
  rows: readonly Row[];
  total?: Row;
}) {
  return (
    <table className="tb-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={c.align === "num" ? "is-num" : undefined}>
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <Rows columns={columns} rows={rows} />
      </tbody>
      {total && (
        <tfoot>
          <Rows columns={columns} rows={[total]} />
        </tfoot>
      )}
    </table>
  );
}

export default function FactTable({
  columns,
  rows,
  total,
  caption,
}: {
  columns: readonly Column[];
  rows: readonly Row[];
  total?: Row;
  caption: string;
}) {
  const first = rows.slice(0, LIST_CAP);
  const next = rows.slice(LIST_CAP, 2 * LIST_CAP);
  const rest = rows.length - first.length - next.length;
  return (
    <section className="tb-block">
      <div className="tb-table-box">
        <Table columns={columns} rows={first} total={total} />
      </div>
      {next.length > 0 && (
        <Fold summary="the next rows" count={next.length}>
          <div className="tb-table-box">
            <Table columns={columns} rows={next} />
          </div>
          {rest > 0 && (
            <p className="tb-more">
              and <Num>{rest}</Num> more
            </p>
          )}
        </Fold>
      )}
      <QueryCaption text={caption} />
    </section>
  );
}

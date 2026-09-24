// FigureStrip — at most six figures in a row, each a number and its name, with
// the query they come from (principle 4).

import { FIGURE_CAP } from "./caps";
import QueryCaption from "./query-caption";

export default function FigureStrip({
  figures,
  caption,
}: {
  figures: readonly { value: number | string; name: string }[];
  caption: string;
}) {
  return (
    <section className="tb-block">
      <div className="tb-strip">
        {figures.slice(0, FIGURE_CAP).map((f) => (
          <div key={f.name} className="tb-figure">
            <span className="tb-figure-value">{f.value}</span>
            <span className="tb-figure-name">{f.name}</span>
          </div>
        ))}
      </div>
      <QueryCaption text={caption} />
    </section>
  );
}

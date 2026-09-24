// THE PAGE TOOLBOX (vqc/pages.md). A Jarvis page file imports from here, from
// its queries, and from nothing else (scripts/check-toolbox-pages.mjs). Each
// component carries its own styling through toolbox.css, imported once here,
// which reads only the colour tokens and the --tb-* scale in app/globals.css.

import "./toolbox.css";

export { default as Page } from "./page-frame";
export { default as Columns } from "./columns";
export { default as PageHead } from "./page-head";
export { default as Num } from "./num";
export { default as AreaFigure } from "./area-figure";
export { default as TimeFigure } from "./time-figure";
export { default as FigureStrip } from "./figure-strip";
export { default as GroupDrawer } from "./group-drawer";
export { default as ItemPanel } from "./item-panel";
export { default as ActionRow } from "./action-row";
export { default as NoteField } from "./note-field";
export { default as FactTable } from "./fact-table";
export { default as Fold } from "./fold";
export { default as Prose } from "./prose";
export { default as QueryCaption } from "./query-caption";
export { default as Term } from "./term";
export { useSurfaceQuery } from "./use-surface-query";
export { useCoarseNow as useNow } from "@/app/lib/hooks/use-coarse-now";

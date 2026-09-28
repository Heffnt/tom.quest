"use client";

// The (i): one per component, placed right after the name of what it explains.
// Pressing it goes straight to that component's explainer, full screen, with a
// close button; Escape closes it too.
//
// The explainer is a whole HTML page written by an agent and committed beside
// the code (<name>.explainer.html). It renders in an iframe sandboxed with
// allow-scripts and WITHOUT allow-same-origin: its script (the diagram) runs in
// an opaque origin, so it cannot read this page's storage, cookies or DOM, and
// the sandbox also refuses it top-level navigation, forms and popups. A
// Content-Security-Policy meta, inserted first thing in its <head>, refuses
// every network load: an explainer loads nothing, so one that tries fails
// closed instead of calling out.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EXPLAINERS, type ExplainerId } from "./explainer-registry.generated";

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

// Keyboard focus inside the iframe stays inside it, so the parent never sees
// that Escape. This one listener, added by the viewer and not by the file,
// hands it up. The sandboxed page can post a message but read nothing back.
const ESCAPE_BRIDGE =
  "<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage('explainer-escape','*')});</script>";

/**
 * The explainer as the iframe receives it, from the file as committed.
 *
 * First, its dark palette is made unconditional. An explainer carries a light
 * and a dark palette and picks one with prefers-color-scheme, and inside an
 * iframe that media query answers with the reader's system setting, never the
 * embedding page's colour scheme (checked in Chromium 153 with color-scheme:
 * dark on the iframe element and on the parent root: still light). The site
 * is dark, so the viewer rewrites the query: a dark block always applies, a
 * light block never does. Opened from disk the file still follows the system.
 *
 * Second, the CSP meta and the Escape bridge go right after <head>. Not
 * before the doctype: anything ahead of it puts the page in quirks mode.
 */
export function prepareExplainer(html: string): string {
  const dark = html
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, "all")
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, "not all")
    .replace(/color-scheme\s*:\s*light\s+dark/gi, "color-scheme: dark");
  const inject = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${ESCAPE_BRIDGE}`;
  const head = /<head[^>]*>/i.exec(dark);
  if (head) return dark.slice(0, head.index + head[0].length) + inject + dark.slice(head.index + head[0].length);
  return `<head>${inject}</head>${dark}`;
}

function ExplainerViewer({ id, onClose }: { id: ExplainerId; onClose: () => void }) {
  const { title, load } = EXPLAINERS[id];
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    load()
      .then((m) => live && setHtml(prepareExplainer(m.default)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => {
    closeRef.current?.focus();
    // Capture phase, so the frame's own Escape (which closes drawers) never
    // sees the key that closed this.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === frameRef.current?.contentWindow && e.data === "explainer-escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("message", onMessage);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-explainer={id}
      className="fixed inset-0 z-(--z-explainer) flex flex-col bg-bg"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface pl-4 pr-1">
        <h2 className="truncate text-[15px] font-semibold text-text">{title}</h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close explainer"
          className="flex h-8 w-8 items-center justify-center rounded-control text-[18px] text-text-muted hover:bg-surface-alt hover:text-text"
        >
          ×
        </button>
      </div>
      {html !== null ? (
        <iframe
          ref={frameRef}
          sandbox="allow-scripts"
          srcDoc={html}
          title={title}
          // Dark form controls and scrollbars; the palette itself is forced
          // by prepareExplainer.
          style={{ colorScheme: "dark" }}
          className="w-full flex-1 border-0 bg-bg"
        />
      ) : (
        <p className="p-4 text-[13px] text-text-faint">{failed ? "The explainer failed to load." : "Loading…"}</p>
      )}
    </div>,
    document.body,
  );
}

export default function Info({ explainer }: { explainer: ExplainerId }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Explainer: ${EXPLAINERS[explainer].title}`}
        aria-haspopup="dialog"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-text-faint font-mono text-[10px] leading-none text-text-muted hover:border-accent hover:text-accent"
      >
        i
      </button>
      {open && <ExplainerViewer id={explainer} onClose={close} />}
    </>
  );
}

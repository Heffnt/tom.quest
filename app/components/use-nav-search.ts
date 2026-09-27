"use client";

// The navigate field's state: the typed query, the ranked page list it
// narrows, the inline completion, the highlighted row and what Enter does.
// NavTerm (every page outside the frame) and the frame's top rail both render
// it, so the two cannot rank or complete pages differently.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth";
import { rankPages, type PageRole } from "./page-routes";

export function useNavSearch() {
  const router = useRouter();
  const { user, role } = useAuth();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pageRole: PageRole = user ? role : "guest";
  const ranked = useMemo(() => rankPages(query, pageRole), [query, pageRole]);
  const suggestion = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !ranked[0]) return "";
    return ranked[0].slug.startsWith(q) && ranked[0].slug !== q ? ranked[0].slug : "";
  }, [query, ranked]);

  useEffect(() => { setCursor(0); }, [query]);

  const submit = useCallback(
    (override?: string) => {
      const target = (override ?? ranked[cursor]?.slug ?? query).trim().toLowerCase();
      if (!target) return;
      router.push(`/${encodeURIComponent(target)}`);
      setQuery("");
      setOpen(false);
    },
    [ranked, cursor, query, router],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setCursor((c) => Math.min(ranked.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (suggestion) setQuery(suggestion);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [ranked.length, suggestion, submit],
  );

  return { query, setQuery, cursor, setCursor, open, setOpen, ranked, suggestion, submit, onKeyDown, inputRef };
}

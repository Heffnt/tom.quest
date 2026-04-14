"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QUESTS, Quest, rankQuests, isValidSlug } from "./routes";

// Shared terminal-nav state + keyboard handling.
// Each mockup consumes this and renders the dropdown differently.
export function useTerminal(initialOpen: boolean = true) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(initialOpen);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const ranked: Quest[] = useMemo(() => rankQuests(query, QUESTS), [query]);

  // Ghost autocomplete: only suggest when top hit is a prefix extension.
  const suggestion = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !ranked[0]) return "";
    return ranked[0].slug.startsWith(q) && ranked[0].slug !== q ? ranked[0].slug : "";
  }, [query, ranked]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const navigate = useCallback((slug: string) => {
    if (isValidSlug(slug)) router.push(`/${slug}`);
    else router.push(`/mockups/v2/lost?q=${encodeURIComponent(slug)}`);
  }, [router]);

  const submit = useCallback((override?: string) => {
    const target = (override ?? ranked[cursor]?.slug ?? query).trim();
    if (!target) return;
    navigate(target);
  }, [ranked, cursor, query, navigate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
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
    }
  }, [ranked.length, suggestion, submit]);

  return {
    query, setQuery,
    open, setOpen,
    cursor, setCursor,
    ranked, suggestion,
    inputRef,
    onKeyDown,
    submit,
  };
}

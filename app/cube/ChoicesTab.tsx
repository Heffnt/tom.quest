"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type { CubeCard, CubeCardsFile, CubeMyRatingsMap } from "./types";

type SortKey = "name" | "cmc" | "color" | "edhrec" | "set" | "rarity" | "type";

function isValidScore(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function getColorKey(card: CubeCard): string {
  const order = new Map([
    ["W", "1"],
    ["U", "2"],
    ["B", "3"],
    ["R", "4"],
    ["G", "5"],
  ]);
  const identity = Array.isArray(card.color_identity) ? card.color_identity : [];
  if (identity.length === 0) return "0";
  return identity.map((c) => order.get(c) ?? "9").join("");
}

function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

export default function ChoicesTab({ userId, accessToken }: { userId: string | null; accessToken: string | null }) {
  const logSource = "CubeChoices";
  const [cards, setCards] = useState<CubeCard[]>([]);
  const [ratingsById, setRatingsById] = useState<CubeMyRatingsMap>({});
  const [loadingCards, setLoadingCards] = useState(true);
  const [loadingRatings, setLoadingRatings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [showRated, setShowRated] = useState(false);
  const [setFilter, setSetFilter] = useState<string>("all");
  const [rarityFilter, setRarityFilter] = useState<string>("all");
  const [typeQuery, setTypeQuery] = useState("");
  const [oracleMustContain, setOracleMustContain] = useState("");
  const [minCmc, setMinCmc] = useState("");
  const [maxCmc, setMaxCmc] = useState("");
  const [selectedColors, setSelectedColors] = useState<Set<string>>(() => new Set());

  const [index, setIndex] = useState(0);
  const [power, setPower] = useState<number | null>(null);
  const [synergy, setSynergy] = useState<number | null>(null);
  const [theme, setTheme] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    logDebug("lifecycle", "Choices tab mounted", { hasUser: !!userId }, logSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const loadCards = async () => {
      setLoadingCards(true);
      setError(null);
      try {
        logDebug("action", "Load cube cards start", undefined, logSource);
        const res = await debugFetch("/data/cube-cards.json", undefined, { source: logSource });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Could not load cube cards");
        }
        const json = (await res.json()) as CubeCardsFile;
        const nextCards = Array.isArray(json.cards) ? json.cards : [];
        setCards(nextCards);
        logDebug("info", "Load cube cards success", { cards: nextCards.length }, logSource);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not load cube cards";
        setError(message);
        logDebug("error", "Load cube cards failed", { message }, logSource);
      } finally {
        setLoadingCards(false);
      }
    };
    loadCards();
  }, []);

  useEffect(() => {
    const loadRatings = async () => {
      if (!userId || !accessToken) {
        setRatingsById({});
        return;
      }
      setLoadingRatings(true);
      setError(null);
      try {
        logDebug("action", "Load my cube ratings start", { userId }, logSource);
        const res = await debugFetch("/api/cube/my-ratings", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }, { source: logSource });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Could not load ratings");
        }
        const data = (await res.json()) as { ratings?: CubeMyRatingsMap };
        setRatingsById(data.ratings ?? {});
        logDebug("info", "Load my cube ratings success", { count: Object.keys(data.ratings ?? {}).length }, logSource);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not load ratings";
        setError(message);
        logDebug("error", "Load my cube ratings failed", { message }, logSource);
      } finally {
        setLoadingRatings(false);
      }
    };
    loadRatings();
  }, [accessToken, userId]);

  const setOptions = useMemo(() => {
    const unique = new Set(cards.map((c) => c.set));
    return Array.from(unique).sort();
  }, [cards]);

  const filteredCards = useMemo(() => {
    const min = parseIntOrNull(minCmc);
    const max = parseIntOrNull(maxCmc);
    const typeNeedle = normalizeText(typeQuery);
    const oracleNeedles = oracleMustContain
      .split(/[,\n]/g)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const colors = selectedColors;

    return cards.filter((card) => {
      if (!showRated && ratingsById[card.id]) return false;
      if (setFilter !== "all" && card.set !== setFilter) return false;
      if (rarityFilter !== "all" && (card.rarity ?? "") !== rarityFilter) return false;
      if (min !== null && (card.cmc ?? 0) < min) return false;
      if (max !== null && (card.cmc ?? 0) > max) return false;
      if (typeNeedle) {
        const hay = normalizeText(card.type_line);
        if (!hay.includes(typeNeedle)) return false;
      }
      if (oracleNeedles.length > 0) {
        const hay = normalizeText(card.oracle_text);
        for (const needle of oracleNeedles) {
          if (!hay.includes(needle)) return false;
        }
      }
      if (colors.size > 0) {
        const identity = Array.isArray(card.color_identity) ? card.color_identity : [];
        const isColorless = identity.length === 0;
        const matchesColorless = colors.has("C") && isColorless;
        const matchesNonColorless = identity.some((c) => colors.has(c));
        if (!matchesColorless && !matchesNonColorless) return false;
      }
      return true;
    });
  }, [cards, maxCmc, minCmc, oracleMustContain, ratingsById, rarityFilter, selectedColors, setFilter, showRated, typeQuery]);

  const sortedCards = useMemo(() => {
    const next = [...filteredCards];
    next.sort((a, b) => {
      if (sortKey === "cmc") return (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name);
      if (sortKey === "color") return getColorKey(a).localeCompare(getColorKey(b)) || a.name.localeCompare(b.name);
      if (sortKey === "edhrec") return (a.edhrec_rank ?? 999999) - (b.edhrec_rank ?? 999999) || a.name.localeCompare(b.name);
      if (sortKey === "set") return a.set.localeCompare(b.set) || a.name.localeCompare(b.name);
      if (sortKey === "rarity") return (a.rarity ?? "").localeCompare(b.rarity ?? "") || a.name.localeCompare(b.name);
      if (sortKey === "type") return (a.type_line ?? "").localeCompare(b.type_line ?? "") || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    return next;
  }, [filteredCards, sortKey]);

  const current = sortedCards[index] ?? null;
  const currentRating = current ? ratingsById[current.id] ?? null : null;

  useEffect(() => {
    if (index < 0) setIndex(0);
    if (index >= sortedCards.length && sortedCards.length > 0) setIndex(sortedCards.length - 1);
    if (sortedCards.length === 0) setIndex(0);
  }, [index, sortedCards.length]);

  useEffect(() => {
    if (!current) {
      setPower(null);
      setSynergy(null);
      setTheme(null);
      setNotes("");
      return;
    }
    setPower(isValidScore(currentRating?.power) ? currentRating.power : null);
    setSynergy(isValidScore(currentRating?.synergy) ? currentRating.synergy : null);
    setTheme(isValidScore(currentRating?.theme) ? currentRating.theme : null);
    setNotes(typeof currentRating?.notes === "string" ? currentRating.notes : "");
  }, [current, currentRating]);

  const toggleColor = useCallback((color: string) => {
    setSelectedColors((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  }, []);

  const saveChoice = useCallback(async (include: boolean) => {
    if (!userId || !accessToken || !current) return;
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      logDebug("action", "Save cube choice", { cardId: current.id, include }, logSource);
      const res = await debugFetch("/api/cube/rate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          scryfall_id: current.id,
          include,
          power,
          synergy,
          theme,
          notes: notes.trim() || null,
        }),
      }, { source: logSource });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : "Could not save choice";
        setError(message);
        logDebug("error", "Save cube choice failed", { message }, logSource);
        return;
      }
      setRatingsById((prev) => ({
        ...prev,
        [current.id]: {
          scryfall_id: current.id,
          include,
          power,
          synergy,
          theme,
          notes: notes.trim() || null,
          updated_at: new Date().toISOString(),
        },
      }));
      setIndex((i) => (showRated ? Math.min(sortedCards.length - 1, i + 1) : i));
      logDebug("info", "Save cube choice success", { cardId: current.id }, logSource);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save choice";
      setError(message);
      logDebug("error", "Save cube choice failed", { message }, logSource);
      return;
    } finally {
      setSaving(false);
    }
  }, [accessToken, current, logSource, notes, power, saving, showRated, sortedCards.length, synergy, theme, userId]);

  if (!userId) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-white/70">
        Log in to make choices.
      </div>
    );
  }

  if (loadingCards) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-white/70">
        Loading cards…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-4 text-red-200">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-white/60 mb-1">Sort</label>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="name">Alphabetical</option>
              <option value="color">Color</option>
              <option value="cmc">Mana value</option>
              <option value="edhrec">EDHREC rank</option>
              <option value="set">Set</option>
              <option value="rarity">Rarity</option>
              <option value="type">Type</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Set</label>
            <select
              value={setFilter}
              onChange={(e) => setSetFilter(e.target.value)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="all">All</option>
              {setOptions.map((set) => (
                <option key={set} value={set}>{set.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Rarity</label>
            <select
              value={rarityFilter}
              onChange={(e) => setRarityFilter(e.target.value)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="all">All</option>
              <option value="common">Common</option>
              <option value="uncommon">Uncommon</option>
              <option value="rare">Rare</option>
              <option value="mythic">Mythic</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Type contains</label>
            <input
              type="text"
              value={typeQuery}
              onChange={(e) => setTypeQuery(e.target.value)}
              className="w-48 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="Creature, Instant…"
            />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Oracle must include</label>
            <input
              type="text"
              value={oracleMustContain}
              onChange={(e) => setOracleMustContain(e.target.value)}
              className="w-56 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="comma-separated"
            />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">MV min</label>
            <input
              type="text"
              value={minCmc}
              onChange={(e) => setMinCmc(e.target.value)}
              className="w-16 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="0"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">MV max</label>
            <input
              type="text"
              value={maxCmc}
              onChange={(e) => setMaxCmc(e.target.value)}
              className="w-16 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="10"
              inputMode="numeric"
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="cube-show-rated"
              type="checkbox"
              checked={showRated}
              onChange={(e) => setShowRated(e.target.checked)}
              className="h-4 w-4 accent-white"
            />
            <label htmlFor="cube-show-rated" className="text-sm text-white/70">
              Show rated
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-white/60">Colors</span>
          {["W", "U", "B", "R", "G", "C"].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleColor(c)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                selectedColors.has(c)
                  ? "border-white/50 bg-white/10 text-white"
                  : "border-white/20 text-white/70 hover:border-white/40 hover:text-white"
              }`}
            >
              {c}
            </button>
          ))}
          <div className="ml-auto text-xs text-white/60">
            {loadingRatings ? "Loading ratings…" : `${sortedCards.length} cards`}
          </div>
        </div>
      </div>

      {sortedCards.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-white/70">
          No cards match these filters.
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between text-xs text-white/60">
            <div>
              Card {index + 1} of {sortedCards.length}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="rounded border border-white/20 px-3 py-1 text-white/70 hover:border-white/40 hover:text-white transition"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(sortedCards.length - 1, i + 1))}
                className="rounded border border-white/20 px-3 py-1 text-white/70 hover:border-white/40 hover:text-white transition"
              >
                Next
              </button>
            </div>
          </div>

          {current && (
            <div className="mt-4 flex flex-col items-center gap-4">
              <img
                src={current.image_uri}
                alt={current.name}
                className="w-full max-w-sm rounded-md border border-white/10"
              />

              <div className="w-full max-w-sm space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-white/60 mb-1">Power</div>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setPower((cur) => (cur === n ? null : n))}
                          className={`h-9 w-9 rounded border text-sm transition ${
                            power === n
                              ? "border-white/50 bg-white/10 text-white"
                              : "border-white/20 text-white/70 hover:border-white/40 hover:text-white"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-white/60 mb-1">Synergy</div>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setSynergy((cur) => (cur === n ? null : n))}
                          className={`h-9 w-9 rounded border text-sm transition ${
                            synergy === n
                              ? "border-white/50 bg-white/10 text-white"
                              : "border-white/20 text-white/70 hover:border-white/40 hover:text-white"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-white/60 mb-1">Theme</div>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setTheme((cur) => (cur === n ? null : n))}
                          className={`h-9 w-9 rounded border text-sm transition ${
                            theme === n
                              ? "border-white/50 bg-white/10 text-white"
                              : "border-white/20 text-white/70 hover:border-white/40 hover:text-white"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-white/60 mb-1">Notes (optional)</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full min-h-[80px] bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40 resize-none"
                    placeholder="Anything to remember…"
                    maxLength={5000}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => saveChoice(true)}
                    className="rounded bg-white text-black py-2 font-medium hover:bg-white/90 transition disabled:opacity-50"
                  >
                    Include
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => saveChoice(false)}
                    className="rounded border border-white/20 py-2 text-white/80 hover:border-white/40 hover:text-white transition disabled:opacity-50"
                  >
                    Exclude
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


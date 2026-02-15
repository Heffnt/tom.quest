"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type { CubeCard, CubeCardsFile, CubeRating } from "./types";

type IncludeFilter = "all" | "include" | "exclude";
type SortKey = "updated" | "name" | "cmc" | "color" | "edhrec" | "set" | "power" | "synergy" | "theme";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function parseScoreFilterOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 5) return null;
  return n;
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

function getUsernameLabel(username: unknown): string {
  if (typeof username === "string" && username.trim()) return username.trim();
  return "unknown";
}

function renderEmojiRow(emoji: string, count: number | null) {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.min(5, count)) : 0;
  if (n <= 0) return null;
  return (
    <div className="flex justify-end gap-0.5">
      {Array.from({ length: n }).map((_, idx) => (
        <span key={idx} className="inline-block w-4 text-center">{emoji}</span>
      ))}
    </div>
  );
}

export default function ReviewTab() {
  const logSource = "CubeReview";
  const [cards, setCards] = useState<CubeCard[]>([]);
  const [ratings, setRatings] = useState<CubeRating[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [userFilter, setUserFilter] = useState<string>("all");
  const [includeFilter, setIncludeFilter] = useState<IncludeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [setFilter, setSetFilter] = useState<string>("all");
  const [rarityFilter, setRarityFilter] = useState<string>("all");
  const [nameQuery, setNameQuery] = useState("");
  const [typeQuery, setTypeQuery] = useState("");
  const [oracleMustContain, setOracleMustContain] = useState("");
  const [minPower, setMinPower] = useState("");
  const [minSynergy, setMinSynergy] = useState("");
  const [minTheme, setMinTheme] = useState("");
  const [selectedColors, setSelectedColors] = useState<Set<string>>(() => new Set());
  const [showUnreviewed, setShowUnreviewed] = useState(false);

  const [selected, setSelected] = useState<{ card: CubeCard; rating: CubeRating | null } | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    logDebug("lifecycle", "Review tab mounted", undefined, logSource);
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        logDebug("action", "Load cube review data start", undefined, logSource);
        const [cardsRes, ratingsRes] = await Promise.all([
          debugFetch("/data/cube-cards.json", undefined, { source: logSource, logResponseBody: false }),
          debugFetch("/api/cube/ratings", undefined, { source: logSource }),
        ]);
        if (!cardsRes.ok) {
          const data = await cardsRes.json().catch(() => ({}));
          logDebug("error", "Load cube cards failed (review)", { status: cardsRes.status, data }, logSource);
          throw new Error(typeof data.error === "string" ? data.error : "Could not load cards");
        }
        if (!ratingsRes.ok) {
          const data = await ratingsRes.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Could not load ratings");
        }
        const cardsJson = (await cardsRes.json()) as CubeCardsFile;
        const ratingsJson = (await ratingsRes.json()) as { ratings?: CubeRating[] };
        const nextCards = Array.isArray(cardsJson.cards) ? cardsJson.cards : [];
        const nextRatings = Array.isArray(ratingsJson.ratings) ? ratingsJson.ratings : [];
        setCards(nextCards);
        setRatings(nextRatings);
        logDebug("info", "Load cube review data success", { cards: nextCards.length, ratings: nextRatings.length }, logSource);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not load cube review data";
        setError(message);
        logDebug("error", "Load cube review data failed", { message }, logSource);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const cardById = useMemo(() => {
    const map = new Map<string, CubeCard>();
    cards.forEach((c) => map.set(c.id, c));
    return map;
  }, [cards]);

  const userOptions = useMemo(() => {
    const byId = new Map<string, string>();
    ratings.forEach((r) => {
      byId.set(r.user_id, getUsernameLabel(r.username));
    });
    return Array.from(byId.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [ratings]);

  const setOptions = useMemo(() => {
    const unique = new Set(cards.map((c) => c.set));
    return Array.from(unique).sort();
  }, [cards]);

  const filtered = useMemo(() => {
    const nameNeedle = normalizeText(nameQuery);
    const typeNeedle = normalizeText(typeQuery);
    const oracleNeedles = oracleMustContain
      .split(/[,\n]/g)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const colors = selectedColors;
    const minPowerScore = parseScoreFilterOrNull(minPower);
    const minSynergyScore = parseScoreFilterOrNull(minSynergy);
    const minThemeScore = parseScoreFilterOrNull(minTheme);
    const anyMetricFilter = minPowerScore !== null || minSynergyScore !== null || minThemeScore !== null;

    const cardMatches = (card: CubeCard) => {
      if (setFilter !== "all" && card.set !== setFilter) return false;
      if (rarityFilter !== "all" && (card.rarity ?? "") !== rarityFilter) return false;
      if (nameNeedle && !normalizeText(card.name).includes(nameNeedle)) return false;
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
    };

    const ratedRows = ratings
      .map((rating) => {
        const card = cardById.get(rating.scryfall_id) ?? null;
        return card ? { card, rating } : null;
      })
      .filter((row): row is { card: CubeCard; rating: CubeRating } => !!row);

    const filteredRated = ratedRows.filter(({ card, rating }) => {
      if (userFilter !== "all" && rating.user_id !== userFilter) return false;
      if (includeFilter === "include" && rating.include !== true) return false;
      if (includeFilter === "exclude" && rating.include !== false) return false;
      if (!cardMatches(card)) return false;
      if (minPowerScore !== null) {
        if (rating.power === null || rating.power < minPowerScore) return false;
      }
      if (minSynergyScore !== null) {
        if (rating.synergy === null || rating.synergy < minSynergyScore) return false;
      }
      if (minThemeScore !== null) {
        if (rating.theme === null || rating.theme < minThemeScore) return false;
      }
      return true;
    });

    if (!showUnreviewed) return filteredRated.map((row) => ({ ...row, isUnreviewed: false }));
    if (includeFilter !== "all") return filteredRated.map((row) => ({ ...row, isUnreviewed: false }));
    if (anyMetricFilter) return filteredRated.map((row) => ({ ...row, isUnreviewed: false }));

    const ratedSet = new Set(
      (userFilter === "all" ? ratings : ratings.filter((r) => r.user_id === userFilter))
        .map((r) => r.scryfall_id)
    );

    const unreviewedRows = cards
      .filter((card) => !ratedSet.has(card.id))
      .filter((card) => cardMatches(card))
      .map((card) => ({ card, rating: null as CubeRating | null, isUnreviewed: true }));

    return [
      ...filteredRated.map((row) => ({ ...row, isUnreviewed: false })),
      ...unreviewedRows,
    ];
  }, [cardById, cards, includeFilter, minPower, minSynergy, minTheme, nameQuery, oracleMustContain, ratings, rarityFilter, selectedColors, setFilter, showUnreviewed, typeQuery, userFilter]);

  const sorted = useMemo(() => {
    const next = [...filtered];
    next.sort((a, b) => {
      const aUpdated = a.rating?.updated_at ?? "";
      const bUpdated = b.rating?.updated_at ?? "";
      const aPower = a.rating?.power ?? 0;
      const bPower = b.rating?.power ?? 0;
      const aSynergy = a.rating?.synergy ?? 0;
      const bSynergy = b.rating?.synergy ?? 0;
      const aTheme = a.rating?.theme ?? 0;
      const bTheme = b.rating?.theme ?? 0;
      if (sortKey === "updated") return bUpdated.localeCompare(aUpdated);
      if (sortKey === "cmc") return (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name);
      if (sortKey === "color") return getColorKey(a.card).localeCompare(getColorKey(b.card)) || a.card.name.localeCompare(b.card.name);
      if (sortKey === "edhrec") return (a.card.edhrec_rank ?? 999999) - (b.card.edhrec_rank ?? 999999) || a.card.name.localeCompare(b.card.name);
      if (sortKey === "set") return a.card.set.localeCompare(b.card.set) || a.card.name.localeCompare(b.card.name);
      if (sortKey === "power") return bPower - aPower || a.card.name.localeCompare(b.card.name);
      if (sortKey === "synergy") return bSynergy - aSynergy || a.card.name.localeCompare(b.card.name);
      if (sortKey === "theme") return bTheme - aTheme || a.card.name.localeCompare(b.card.name);
      return a.card.name.localeCompare(b.card.name);
    });
    return next;
  }, [filtered, sortKey]);

  const toggleColor = useCallback((color: string) => {
    setSelectedColors((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  }, []);

  const copyVisibleNames = useCallback(async () => {
    const unique = new Set(sorted.map(({ card }) => card.name));
    const text = Array.from(unique).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setCopySuccess(false), 2000);
      logDebug("info", "Copied cube review names", { count: unique.size }, logSource);
    } catch (e) {
      logDebug("error", "Copy cube review names failed", { message: e instanceof Error ? e.message : "clipboard_error" }, logSource);
    }
  }, [sorted]);

  if (loading) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-white/70">
        Loading cube review…
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
            <label className="block text-xs text-white/60 mb-1">User</label>
            <select
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="all">All</option>
              {userOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Choice</label>
            <select
              value={includeFilter}
              onChange={(e) => setIncludeFilter(e.target.value as IncludeFilter)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="all">All</option>
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Sort</label>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
            >
              <option value="updated">Last updated</option>
              <option value="name">Alphabetical</option>
              <option value="color">Color</option>
              <option value="cmc">Mana value</option>
              <option value="edhrec">EDHREC rank</option>
              <option value="set">Set</option>
              <option value="power">Power</option>
              <option value="synergy">Synergy</option>
              <option value="theme">Theme</option>
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
            <label className="block text-xs text-white/60 mb-1">Name contains</label>
            <input
              type="text"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              className="w-48 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="Lightning Helix…"
            />
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
            <label className="block text-xs text-white/60 mb-1">Power ≥</label>
            <input
              type="text"
              value={minPower}
              onChange={(e) => setMinPower(e.target.value)}
              className="w-16 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="1-5"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Synergy ≥</label>
            <input
              type="text"
              value={minSynergy}
              onChange={(e) => setMinSynergy(e.target.value)}
              className="w-16 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="1-5"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Theme ≥</label>
            <input
              type="text"
              value={minTheme}
              onChange={(e) => setMinTheme(e.target.value)}
              className="w-16 bg-black border border-white/20 rounded px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-white/40"
              placeholder="1-5"
              inputMode="numeric"
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <input
              id="cube-show-unreviewed"
              type="checkbox"
              checked={showUnreviewed}
              onChange={(e) => setShowUnreviewed(e.target.checked)}
              className="h-4 w-4 accent-white"
            />
            <label htmlFor="cube-show-unreviewed" className="text-sm text-white/70">
              Show unreviewed
            </label>
          </div>
          <button
            type="button"
            onClick={copyVisibleNames}
            className="ml-auto rounded border border-white/20 px-4 py-2 text-sm text-white/70 hover:border-white/40 hover:text-white transition"
            title="Copy visible card names"
          >
            {copySuccess ? "✓" : "Copy"}
          </button>
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
            Showing {sorted.length} ratings
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-white/70">
          No ratings match these filters.
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 gap-1">
          {sorted.map(({ card, rating, isUnreviewed }) => (
            <button
              key={rating ? `${rating.user_id}:${rating.scryfall_id}` : `unreviewed:${card.id}`}
              type="button"
              onClick={() => setSelected({ card, rating })}
              className="group relative"
            >
              <img
                src={card.image_uri}
                alt={card.name}
                className={`w-full rounded-sm border-2 ${
                  !rating
                    ? "border-white/10"
                    : rating.include
                      ? "border-green-400"
                      : "border-red-400"
                }`}
                loading="lazy"
              />
              {!isUnreviewed && rating && (
                <div className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-1 text-[11px] leading-tight text-white/90">
                  <div className="text-right">{getUsernameLabel(rating.username)}</div>
                  <div className="mt-0.5 flex flex-col items-end gap-0.5 text-[12px]">
                    {renderEmojiRow("💪", rating.power)}
                    {renderEmojiRow("🤝", rating.synergy)}
                    {renderEmojiRow("👑", rating.theme)}
                    {rating.notes && rating.notes.trim() ? (
                      <div className="flex justify-end">
                        <span className="inline-block w-4 text-center">📝</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelected(null)} />
          <div className="relative w-full max-w-3xl rounded-lg border border-white/20 bg-black p-6">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="absolute right-4 top-4 text-white/60 hover:text-white"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="grid gap-6 md:grid-cols-2">
              <img
                src={selected.card.image_uri}
                alt={selected.card.name}
                className="w-full rounded-md border border-white/10"
              />
              <div className="space-y-3 text-sm text-white/80">
                {selected.rating ? (
                  <>
                    <div className="text-white/60">
                      <div>
                        <span className="text-white/60">User:</span> {getUsernameLabel(selected.rating.username)}
                      </div>
                      <div>
                        <span className="text-white/60">Choice:</span> {selected.rating.include ? "Include" : "Exclude"}
                      </div>
                      <div>
                        <span className="text-white/60">Updated:</span> {selected.rating.updated_at}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="rounded border border-white/10 bg-white/5 p-3">
                        <div className="text-xs text-white/60">Power</div>
                        <div className="mt-1 text-lg">{renderEmojiRow("💪", selected.rating.power) ?? "—"}</div>
                      </div>
                      <div className="rounded border border-white/10 bg-white/5 p-3">
                        <div className="text-xs text-white/60">Synergy</div>
                        <div className="mt-1 text-lg">{renderEmojiRow("🤝", selected.rating.synergy) ?? "—"}</div>
                      </div>
                      <div className="rounded border border-white/10 bg-white/5 p-3">
                        <div className="text-xs text-white/60">Theme</div>
                        <div className="mt-1 text-lg">{renderEmojiRow("👑", selected.rating.theme) ?? "—"}</div>
                      </div>
                    </div>
                    {selected.rating.notes && (
                      <div className="rounded border border-white/10 bg-white/5 p-3 whitespace-pre-wrap">
                        {selected.rating.notes}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded border border-white/10 bg-white/5 p-4 text-white/70">
                    Unreviewed.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


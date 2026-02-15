import fs from "node:fs/promises";
import path from "node:path";

const SET_QUERY = "(e:rav or e:gpt or e:dis or e:rtr or e:gtc or e:dgm or e:grn or e:rna or e:war)";
const QUERY = `${SET_QUERY} game:paper -is:token -is:extra -t:basic`;
const REQUEST_DELAY_MS = 120;
const OUT_FILE = path.join(process.cwd(), "public", "data", "cube-cards.json");

// Scryfall requires explicit User-Agent and Accept headers.
const USER_AGENT = "tom.Quest/1.0 (cube downloader; https://tom.quest)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Scryfall request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }
  return response.json();
}

function pickFace(card) {
  if (Array.isArray(card.card_faces) && card.card_faces.length > 0) {
    return card.card_faces[0];
  }
  return null;
}

function pickImageUri(card) {
  if (card.image_uris && typeof card.image_uris.normal === "string") return card.image_uris.normal;
  const face = pickFace(card);
  if (face?.image_uris && typeof face.image_uris.normal === "string") return face.image_uris.normal;
  return null;
}

function coalesceText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeCard(card) {
  const face = pickFace(card);
  const oracleText = coalesceText(
    card.oracle_text,
    Array.isArray(card.card_faces)
      ? card.card_faces
          .map((f) => (typeof f.oracle_text === "string" ? f.oracle_text : ""))
          .filter(Boolean)
          .join("\n\n")
      : null,
  );

  return {
    id: card.id,
    oracle_id: card.oracle_id ?? null,
    name: card.name,
    set: card.set,
    set_name: card.set_name ?? null,
    collector_number: card.collector_number ?? null,
    rarity: card.rarity ?? null,
    released_at: card.released_at ?? null,
    mana_cost: coalesceText(card.mana_cost, face?.mana_cost),
    cmc: typeof card.cmc === "number" ? card.cmc : null,
    colors: Array.isArray(card.colors) ? card.colors : (Array.isArray(face?.colors) ? face.colors : []),
    color_identity: Array.isArray(card.color_identity) ? card.color_identity : [],
    type_line: coalesceText(card.type_line, face?.type_line),
    oracle_text: oracleText,
    keywords: Array.isArray(card.keywords) ? card.keywords : [],
    edhrec_rank: typeof card.edhrec_rank === "number" ? card.edhrec_rank : null,
    power: coalesceText(card.power, face?.power),
    toughness: coalesceText(card.toughness, face?.toughness),
    image_uri: pickImageUri(card),
  };
}

async function main() {
  const startUrl = new URL("https://api.scryfall.com/cards/search");
  startUrl.searchParams.set("q", QUERY);

  let url = startUrl.toString();
  let page = 0;
  let totalRaw = 0;
  let skippedNoImage = 0;
  const byName = new Map();

  console.log(`Query: ${QUERY}`);
  while (url) {
    page += 1;
    const json = await fetchJson(url);
    const data = Array.isArray(json.data) ? json.data : [];
    totalRaw += data.length;

    for (const card of data) {
      if (!card || typeof card.name !== "string" || typeof card.id !== "string") continue;
      if (byName.has(card.name)) continue;
      const normalized = normalizeCard(card);
      if (!normalized.image_uri) {
        skippedNoImage += 1;
        continue;
      }
      byName.set(card.name, normalized);
    }

    url = json.has_more ? json.next_page : "";
    if (url) {
      process.stdout.write(`Fetched page ${page} (${data.length} prints) -> uniques ${byName.size}\r`);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log("");
  const cards = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  const out = {
    generated_at: new Date().toISOString(),
    query: QUERY,
    total_prints_seen: totalRaw,
    unique_cards: cards.length,
    skipped_no_image: skippedNoImage,
    cards,
  };

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${cards.length} cards to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});


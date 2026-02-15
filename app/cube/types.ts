export type CubeTab = "choices" | "review";

export type CubeCard = {
  id: string;
  oracle_id: string | null;
  name: string;
  set: string;
  set_name: string | null;
  collector_number: string | null;
  rarity: string | null;
  released_at: string | null;
  mana_cost: string | null;
  cmc: number | null;
  colors: string[];
  color_identity: string[];
  type_line: string | null;
  oracle_text: string | null;
  keywords: string[];
  edhrec_rank: number | null;
  power: string | null;
  toughness: string | null;
  image_uri: string;
};

export type CubeCardsFile = {
  generated_at: string;
  query: string;
  total_prints_seen: number;
  unique_cards: number;
  skipped_no_image: number;
  cards: CubeCard[];
};

export type CubeRating = {
  id: string;
  user_id: string;
  scryfall_id: string;
  power: number | null;
  synergy: number | null;
  theme: number | null;
  include: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  username?: string | null;
};

export type CubeRatingMapEntry = {
  scryfall_id: string;
  include: boolean;
  power: number | null;
  synergy: number | null;
  theme: number | null;
  notes: string | null;
  updated_at: string;
};

export type CubeMyRatingsMap = Record<string, CubeRatingMapEntry>;


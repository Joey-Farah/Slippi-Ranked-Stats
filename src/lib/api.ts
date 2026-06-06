// Use Tauri's HTTP plugin (Rust-side fetch, bypasses CORS)
import { fetch } from "@tauri-apps/plugin-http";

const GRAPHQL_URL = "https://internal.slippi.gg/graphql";

const HEADERS = {
  "content-type": "application/json",
  "accept": "*/*",
  "apollographql-client-name": "slippi-web",
};

export interface RatingSnapshot {
  timestamp: string;
  rating: number;
  wins: number;
  losses: number;
  global_rank: number;
  regional_rank: number;
  continent: string;
}

export interface SeasonData {
  season_id: string;
  season_name: string;
  season_start: string;
  season_end: string;
  rating: number;
  wins: number;
  losses: number;
}

// A character the player has used this ranked season, with their game count. `character`
// is the Slippi API enum string (e.g. "FOX", "CAPTAIN_FALCON") — map via API_CHAR_TO_EXTERNAL.
export interface ProfileCharacter {
  character: string;
  gameCount: number;
}

// Same query the slippi.gg website sends (matches v1 api.py exactly).
// characters { character gameCount } gives us API-side char IDs for cross-reference.
const PROFILE_QUERY = `
  fragment profileFields on NetplayProfile {
    ratingOrdinal wins losses
    dailyGlobalPlacement dailyRegionalPlacement continent
    characters { character gameCount }
  }

  query UserProfilePageQuery($cc: String, $uid: String) {
    getUser(fbUid: $uid, connectCode: $cc) {
      displayName
      connectCode { code }
      rankedNetplayProfile { ...profileFields }
      rankedNetplayProfileHistory {
        ...profileFields
        season { id startedAt endedAt name }
      }
    }
  }
`;

async function graphql<T>(query: string, variables: Record<string, string | null>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Slippi API ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data as T;
}

export async function fetchRatingSnapshot(
  connectCode: string
): Promise<{ snapshot: RatingSnapshot; seasons: SeasonData[]; displayName: string; characters: ProfileCharacter[] }> {
  const cc = connectCode.toUpperCase().replace("/", "#");
  const data = await graphql<any>(PROFILE_QUERY, { cc, uid: null });

  const user = data?.getUser;
  if (!user) throw new Error("Connect code not found: " + cc);

  const displayName: string = user.displayName ?? "";
  const profile = user.rankedNetplayProfile ?? {};
  const history: any[] = user.rankedNetplayProfileHistory ?? [];

  // The current season's characters, most-played first. Empty after a season reset or for
  // a brand-new player. Used by the overlay to show the opponent's actual mains (rather
  // than the lagging per-game character) — see API_CHAR_TO_EXTERNAL in char-icons.ts.
  const characters: ProfileCharacter[] = (profile.characters ?? [])
    .map((c: any) => ({ character: String(c.character ?? ""), gameCount: c.gameCount ?? 0 }))
    .filter((c: ProfileCharacter) => c.character && c.gameCount > 0)
    .sort((a: ProfileCharacter, b: ProfileCharacter) => b.gameCount - a.gameCount);

  const snapshot: RatingSnapshot = {
    timestamp: new Date().toISOString(),
    rating: profile.ratingOrdinal ?? 0,
    wins: profile.wins ?? 0,
    losses: profile.losses ?? 0,
    global_rank: profile.dailyGlobalPlacement ?? 0,
    regional_rank: profile.dailyRegionalPlacement ?? 0,
    continent: profile.continent ?? "",
  };

  const seasons: SeasonData[] = history.map((entry: any) => ({
    season_id: String(entry.season?.id ?? ""),
    season_name: entry.season?.name ?? "",
    season_start: entry.season?.startedAt ?? "",
    season_end: entry.season?.endedAt ?? "",
    rating: entry.ratingOrdinal ?? 0,
    wins: entry.wins ?? 0,
    losses: entry.losses ?? 0,
  }));

  return { snapshot, seasons, displayName, characters };
}

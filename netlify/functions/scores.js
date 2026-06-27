// netlify/functions/scores.js
// Appel sécurisé à API-FOOTBALL / API-SPORTS.
// La clé reste cachée dans Netlify : Environment variable FOOTBALL_API_KEY.
// Le front appelle : /.netlify/functions/scores
//
// Réponse volontairement compatible avec ton live.json actuel :
// { updatedAt, source, matches: { "cro-gha": { home, away, status } } }

const API_BASE = "https://v3.football.api-sports.io";

// Coupe du Monde FIFA dans API-FOOTBALL.
// Si l'ID varie dans ton compte API, tu peux le surcharger dans Netlify avec FOOTBALL_LEAGUE_ID.
const LEAGUE_ID = process.env.FOOTBALL_LEAGUE_ID || "1";
const SEASON = process.env.FOOTBALL_SEASON || "2026";

// Cache anti-explosion du quota gratuit.
// 300s = 5 minutes. Si tu veux économiser davantage le quota, mets 600 ou 900 via Netlify FOOTBALL_CACHE_SECONDS.
const CACHE_SECONDS = Number(process.env.FOOTBALL_CACHE_SECONDS || 90);

let memoryCache = {
  expiresAt: 0,
  body: null,
};

const TRACKED_MATCHES = {
  "uru-esp": { home: "URU", away: "ESP" },
  "cpv-ksa": { home: "CPV", away: "KSA" },
  "egy-irn": { home: "EGY", away: "IRN" },
  "nzl-bel": { home: "NZL", away: "BEL" },
  "cro-gha": { home: "CRO", away: "GHA" },
  "pan-eng": { home: "PAN", away: "ENG" },
  "col-por": { home: "COL", away: "POR" },
  "cod-uzb": { home: "COD", away: "UZB" },
  "jor-arg": { home: "JOR", away: "ARG" },
  "alg-aut": { home: "ALG", away: "AUT" },
};

const TEAM_ALIASES = {
  URU: ["Uruguay"],
  ESP: ["Spain", "Espagne"],
  CPV: ["Cape Verde", "Cabo Verde", "Cap Vert", "Cap-Vert"],
  KSA: ["Saudi Arabia", "Saudi-Arabia", "Arabie Saoudite", "Arabie saoudite"],
  EGY: ["Egypt", "Egypte", "Égypte"],
  IRN: ["Iran", "IR Iran", "Iran IR"],
  NZL: ["New Zealand", "Nouvelle-Zélande", "Nouvelle Zelande"],
  BEL: ["Belgium", "Belgique"],
  CRO: ["Croatia", "Croatie"],
  GHA: ["Ghana"],
  PAN: ["Panama"],
  ENG: ["England", "Angleterre"],
  COL: ["Colombia", "Colombie"],
  POR: ["Portugal"],
  COD: ["Congo DR", "DR Congo", "Congo DR", "D.R. Congo", "RD Congo", "Democratic Republic of Congo", "Congo"],
  UZB: ["Uzbekistan", "Ouzbékistan", "Ouzbekistan"],
  JOR: ["Jordan", "Jordanie"],
  ARG: ["Argentina", "Argentine"],
  ALG: ["Algeria", "Algérie", "Algerie"],
  AUT: ["Austria", "Autriche"],
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=30, s-maxage=${CACHE_SECONDS}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function teamMatches(apiTeam, code) {
  const apiName = normalize(apiTeam?.name);
  const aliases = TEAM_ALIASES[code] || [code];

  return aliases.some((alias) => {
    const a = normalize(alias);
    return apiName === a || apiName.includes(a) || a.includes(apiName);
  });
}

function mapStatus(apiStatusShort) {
  const s = String(apiStatusShort || "").toUpperCase();

  if (["FT", "AET", "PEN", "AWD", "WO"].includes(s)) return "final";
  if (["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"].includes(s)) return "live";
  if (["PST"].includes(s)) return "postponed";
  if (["CANC", "ABD"].includes(s)) return "cancelled";

  return "scheduled";
}

function toMatchPayload(apiFixture, key, reversed = false) {
  const goals = apiFixture?.goals || {};
  const fixture = apiFixture?.fixture || {};
  const status = fixture?.status || {};
  const teams = apiFixture?.teams || {};

  const homeScore = goals.home;
  const awayScore = goals.away;

  return {
    home: reversed ? awayScore : homeScore,
    away: reversed ? homeScore : awayScore,
    status: mapStatus(status.short),
    minute: status.elapsed ?? null,
    apiStatus: status.short || null,
    apiStatusLong: status.long || null,
    fixtureId: fixture.id || null,
    date: fixture.date || null,
    homeName: reversed ? teams.away?.name : teams.home?.name,
    awayName: reversed ? teams.home?.name : teams.away?.name,
  };
}

function findTrackedMatch(apiFixture) {
  const homeTeam = apiFixture?.teams?.home;
  const awayTeam = apiFixture?.teams?.away;

  for (const [key, expected] of Object.entries(TRACKED_MATCHES)) {
    const normal =
      teamMatches(homeTeam, expected.home) &&
      teamMatches(awayTeam, expected.away);

    if (normal) {
      return { key, reversed: false };
    }

    const reversed =
      teamMatches(homeTeam, expected.away) &&
      teamMatches(awayTeam, expected.home);

    if (reversed) {
      return { key, reversed: true };
    }
  }

  return null;
}

async function fetchFixtures({ from, to }) {
  const apiKey = process.env.FOOTBALL_API_KEY;

  if (!apiKey) {
    throw new Error("FOOTBALL_API_KEY is not configured in Netlify environment variables.");
  }

  const url = new URL(`${API_BASE}/fixtures`);
  url.searchParams.set("league", LEAGUE_ID);
  url.searchParams.set("season", SEASON);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("timezone", "Europe/Paris");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": apiKey,
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`API-FOOTBALL HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data?.errors && Object.keys(data.errors).length) {
    throw new Error(`API-FOOTBALL error: ${JSON.stringify(data.errors)}`);
  }

  return {
    endpoint: "/fixtures",
    from,
    to,
    rawCount: Array.isArray(data?.response) ? data.response.length : 0,
    fixtures: Array.isArray(data?.response) ? data.response : [],
  };
}

exports.handler = async function handler(event) {
  try {
    const now = Date.now();

    if (memoryCache.body && memoryCache.expiresAt > now) {
      return json(200, {
        ...memoryCache.body,
        cache: "memory",
      });
    }

    const params = event?.queryStringParameters || {};
    const today = new Date();

    // Par défaut : hier → +3 jours.
    // Tu peux forcer avec /.netlify/functions/scores?from=2026-06-26&to=2026-06-28
    const from = params.from || process.env.FOOTBALL_DATE_FROM || ymd(addDays(today, -1));
    const to = params.to || process.env.FOOTBALL_DATE_TO || ymd(addDays(today, 3));

    const api = await fetchFixtures({ from, to });

    const matches = {};
    for (const fixture of api.fixtures) {
      const found = findTrackedMatch(fixture);
      if (!found) continue;

      matches[found.key] = toMatchPayload(fixture, found.key, found.reversed);
    }

    const body = {
      updatedAt: new Date().toISOString(),
      source: "api-football",
      provider: "API-SPORTS",
      leagueId: LEAGUE_ID,
      season: SEASON,
      from,
      to,
      cacheSeconds: CACHE_SECONDS,
      foundMatches: Object.keys(matches).length,
      rawFixtures: api.rawCount,
      matches,
    };

    memoryCache = {
      expiresAt: now + CACHE_SECONDS * 1000,
      body,
    };

    return json(200, body);
  } catch (error) {
    return json(500, {
      updatedAt: new Date().toISOString(),
      source: "api-football",
      error: true,
      message: error.message,
      hint: "Vérifie FOOTBALL_API_KEY dans Netlify, puis teste /.netlify/functions/scores",
    }, {
      "Cache-Control": "no-store",
    });
  }
};

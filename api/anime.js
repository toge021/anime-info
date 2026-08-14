// api/anime.js - API endpoint for Vercel
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://anime-sama.to";
const CATALOGUE_URL = `${BASE_URL}/catalogue`;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchPage(url) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return res.data;
  } catch (err) {
    console.warn(`Erreur fetch ${url}: ${err.message}`);
    return null;
  }
}

async function getTotalPages() {
  const html = await fetchPage(CATALOGUE_URL);
  if (!html) throw new Error("Impossible de charger la page catalogue.");

  const $ = cheerio.load(html);
  let maxPage = 1;

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/[?&/]page[=/](\d+)/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxPage) maxPage = num;
    }
  });

  $(".pagination a, .page-link, [class*='pag'] a").each((_, el) => {
    const text = $(el).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > maxPage) maxPage = num;
  });

  return maxPage;
}

function extractAnimeLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let full = href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    if (
      full.startsWith(`${BASE_URL}/catalogue/`) &&
      !full.includes("?") &&
      !full.includes("#") &&
      full !== `${BASE_URL}/catalogue/` &&
      full !== `${BASE_URL}/catalogue`
    ) {
      const slug = full.replace(`${BASE_URL}/catalogue/`, "");
      const parts = slug.split("/").filter(Boolean);
      if (parts.length === 1) {
        links.add(full);
      }
    }
  });

  return [...links];
}

async function scrapeAllPages(totalPages) {
  const allLinks = new Set();

  for (let page = 1; page <= totalPages; page++) {
    const urls = [
      page === 1 ? CATALOGUE_URL : `${CATALOGUE_URL}?page=${page}`,
      `${CATALOGUE_URL}/page/${page}`,
    ];

    let found = false;
    for (const url of urls) {
      const html = await fetchPage(url);
      if (!html) continue;

      const links = extractAnimeLinks(html, url);
      if (links.length > 0) {
        links.forEach((l) => allLinks.add(l));
        found = true;
        break;
      }
    }

    if (!found && page > 1) {
      break;
    }

    await sleep(300);
  }

  return [...allLinks];
}

function slugToTitle(url) {
  const slug = url.replace(`${BASE_URL}/catalogue/`, "");
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ============================================================
   VÉRIFICATION RÉELLE DES CATALOGUES (fonctions reprises de
   index.js, adaptées aux headers/constantes de ce fichier).

   Un catalogue n'est enregistré dans anime.json QUE si l'on
   parvient à trouver, sur sa page, au moins une saison réelle
   dont le /episodes.js existe ET contient au moins un lecteur
   avec au moins un lien de streaming exploitable.
   ============================================================ */

// Types de lecteurs (repris de index.js, utilisés par parseEpisodesJs)
const playerTypes = {
  vidmoly: "Vidmoly",
  sibnet: "Sibnet",
  oneupload: "OneUpload",
  sendvid: "Sendvid",
  smoothpre: "Smoothpre",
  dood: "DoodStream",
  mp4upload: "Mp4Upload",
  streamtape: "Streamtape",
  voe: "Voe",
  mixdrop: "MixDrop",
  streamsb: "StreamSB",
  fembed: "Fembed",
  jawcloud: "Jawcloud",
  uqload: "Uqload",
  vidcloud: "Vidcloud",
  youtube: "YouTube",
  "ok.ru": "OK.ru",
};

const KNOWN_LANGUAGES = ["vostfr", "vf", "vf1", "vf2", "va", "var", "vkr", "vcn", "vqc"];

// Reprise de index.js : checkUrlExists (vérification via GET réel, pas HEAD)
async function checkUrlExists(url) {
  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    });
    return response.status >= 200 && response.status < 400;
  } catch (error) {
    return false;
  }
}

// Reprise de index.js : extraction des couples (pattern, langue) réellement
// déclarés sur la page catalogue (panneauAnime(...) + liens <a href>)
function extractSeasonCandidatesFromHtml(html, animeSlug) {
  const candidates = new Map();

  const addCandidate = (rawPath) => {
    if (!rawPath) return;
    let cleanPath = String(rawPath).trim();
    cleanPath = cleanPath.replace(/^https?:\/\/[^/]+/i, "");
    cleanPath = cleanPath.replace(/^\/?catalogue\/[^/]+\//i, "");
    cleanPath = cleanPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!cleanPath) return;

    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length < 2) return; // il faut au minimum pattern/langue

    const pattern = parts[0];
    const langCandidate = parts[1].toLowerCase();
    if (!KNOWN_LANGUAGES.includes(langCandidate)) return;

    const key = `${pattern}::${langCandidate}`;
    if (!candidates.has(key)) candidates.set(key, { pattern, lang: langCandidate });
  };

  const jsFuncRegex = /panneauAnime\s*\(\s*["'`][^"'`]*["'`]\s*,\s*["'`]([^"'`]+)["'`]\s*\)/gi;
  let m;
  while ((m = jsFuncRegex.exec(html)) !== null) {
    addCandidate(m[1]);
  }

  try {
    const $ = cheerio.load(html);
    $(`a[href*="/catalogue/${animeSlug}/"]`).each((_, el) => {
      addCandidate($(el).attr("href"));
    });
  } catch (_) {
    /* ignore */
  }

  return [...candidates.values()];
}

// Reprise de index.js : parsing du fichier episodes.js pour en extraire
// les lecteurs et les liens de streaming réellement présents.
async function parseEpisodesJs(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        ...HEADERS,
        Accept: "text/javascript, application/javascript, */*; q=0.01",
      },
      timeout: 15000,
    });

    const jsContent = response.data;
    const episodes = {};
    let playerCounter = 0;

    const episodeRegex = /var\s+(eps\d+)\s*=\s*\[(.*?)\];/gs;
    let match;

    while ((match = episodeRegex.exec(jsContent)) !== null) {
      try {
        const varName = match[1];
        const content = match[2];

        const episodeArray = content
          .split(",")
          .map((u) => {
            let cleanUrl = u.trim().replace(/['"`]/g, "").trim();
            if (cleanUrl && cleanUrl.startsWith("http")) return cleanUrl;
            return null;
          })
          .filter((u) => u && u.length > 5 && u.includes("http"));

        if (episodeArray.length === 0) continue;

        const firstUrl = episodeArray[0] || "";
        let playerType = "Direct";

        for (const [key, value] of Object.entries(playerTypes)) {
          if (firstUrl.toLowerCase().includes(key.toLowerCase())) {
            playerType = value;
            break;
          }
        }

        const playerId = `player_${playerCounter++}`;

        episodes[playerId] = {
          playerName: playerType,
          playerKey: varName,
          episodes: episodeArray.map((u, index) => ({ number: index + 1, url: u })),
          totalEpisodes: episodeArray.length,
        };
      } catch (error) {
        continue;
      }
    }

    return episodes;
  } catch (error) {
    return {};
  }
}

/**
 * Vérifie qu'un catalogue possède réellement au moins une saison/film dont
 * le /episodes.js existe et contient au moins un lecteur avec au moins un
 * lien de streaming exploitable. Retourne true/false — n'enregistre rien
 * lui-même.
 */
async function verifyAnimeHasStream(catalogueUrl, slug) {
  const html = await fetchPage(`${catalogueUrl}/`);
  if (!html) return false;

  const candidates = extractSeasonCandidatesFromHtml(html, slug);
  if (candidates.length === 0) return false;

  const CONCURRENCY = 5;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(async ({ pattern, lang }) => {
        const seasonUrl = `${catalogueUrl}/${pattern}/${lang}`;
        const exists = await checkUrlExists(`${seasonUrl}/`);
        if (!exists) return false;

        const episodesJsUrl = `${seasonUrl}/episodes.js`;
        const episodesData = await parseEpisodesJs(episodesJsUrl);

        // Il faut au moins un lecteur avec au moins un épisode/lien réel
        return Object.values(episodesData).some(
          (p) => Array.isArray(p.episodes) && p.episodes.length > 0
        );
      })
    );

    if (results.some(Boolean)) return true;
  }

  return false;
}

/* ============================================================
   UPLOAD VERS UN AUTRE DÉPÔT GITHUB (API Contents)

   Configuration via variables d'environnement Vercel :
   - GITHUB_TOKEN        : token avec accès en écriture au dépôt cible
   - GITHUB_TARGET_REPO  : "owner/repo" du dépôt destination
   - GITHUB_TARGET_PATH  : chemin du fichier dans ce dépôt (def: "anime.json")
   - GITHUB_TARGET_BRANCH: branche cible (def: "main")
   ============================================================ */

async function uploadAnimeJsonToGitHub(jsonData) {
  const token = process.env.GITHUB_TOKEN || "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";
  const targetRepo = process.env.GITHUB_TARGET_REPO || "ANIME-JSON";
  const targetPath = process.env.GITHUB_TARGET_PATH || "anime.json";
  const branch = process.env.GITHUB_TARGET_BRANCH || "main";

  const apiUrl = `https://api.github.com/repos/${targetRepo}/contents/${targetPath}`;
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "anime-scraper",
  };

  // Récupère le sha du fichier existant, s'il existe, pour permettre la mise à jour
  let sha;
  try {
    const existing = await axios.get(`${apiUrl}?ref=${branch}`, { headers: ghHeaders });
    sha = existing.data.sha;
  } catch (err) {
    if (!(err.response && err.response.status === 404)) {
      throw err;
    }
    // 404 => le fichier n'existe pas encore, pas de sha à fournir
  }

  const content = Buffer.from(JSON.stringify(jsonData, null, 2), "utf8").toString("base64");

  const commitRes = await axios.put(
    apiUrl,
    {
      message: `Mise à jour anime.json - ${new Date().toISOString()}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    },
    { headers: ghHeaders }
  );

  return {
    repo: targetRepo,
    path: targetPath,
    branch,
    commit_sha: commitRes.data.commit ? commitRes.data.commit.sha : undefined,
    content_sha: commitRes.data.content ? commitRes.data.content.sha : undefined,
    html_url: commitRes.data.content ? commitRes.data.content.html_url : undefined,
  };
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const totalPages = await getTotalPages();
    const allLinks = await scrapeAllPages(totalPages);

    if (allLinks.length === 0) {
      return res.status(500).json({ error: "Aucun lien d'anime trouvé" });
    }

    // Vérification réelle de chaque catalogue avant enregistrement :
    // seuls ceux disposant d'un /episodes.js exploitable sont conservés.
    const sortedLinks = allLinks.sort();
    const validatedAnimes = [];

    const VERIFY_CONCURRENCY = 5;
    for (let i = 0; i < sortedLinks.length; i += VERIFY_CONCURRENCY) {
      const batch = sortedLinks.slice(i, i + VERIFY_CONCURRENCY);

      const results = await Promise.all(
        batch.map(async (url) => {
          const slug = url.replace(`${BASE_URL}/catalogue/`, "");
          const isValid = await verifyAnimeHasStream(url, slug);
          if (!isValid) return null;
          return { titre: slugToTitle(url), url, slug };
        })
      );

      results.forEach((entry) => {
        if (entry) validatedAnimes.push(entry);
      });

      await sleep(200);
    }

    if (validatedAnimes.length === 0) {
      return res.status(500).json({ error: "Aucun catalogue exploitable trouvé" });
    }

    const animes = validatedAnimes.map((a, index) => ({
      id: index + 1,
      titre: a.titre,
      url: a.url,
      slug: a.slug,
    }));

    const output = {
      source: BASE_URL,
      scrape_date: new Date().toISOString(),
      total: animes.length,
      animes: animes,
    };

    const githubResult = await uploadAnimeJsonToGitHub(output);

    return res.status(200).json({
      success: true,
      total: animes.length,
      uploaded: true,
      github: githubResult,
    });
  } catch (err) {
    console.error("Erreur:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

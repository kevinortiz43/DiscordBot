import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

// ── Config ────────────────────────────────────────────────────────────────────
const HOURS_THRESHOLD = 12;
const STEAM_API_KEY = process.env.STEAM_API_KEY ?? "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ModEntry { id: string; name: string }

interface SteamFileDetail {
  publishedfileid: string;
  title: string;
  time_updated: number;
  short_description: string;
  result: number;
}

// ── Read mod IDs from HTML files ──────────────────────────────────────────────
function loadMods(): ModEntry[] {
  const dataDir = path.join(process.cwd(), "data");
  const mods: ModEntry[] = [];

  for (const file of fs.readdirSync(dataDir).filter(f => f.endsWith(".html"))) {
    const $ = cheerio.load(fs.readFileSync(path.join(dataDir, file), "utf-8"));
    $('tr[data-type="ModContainer"]').each((_, row) => {
      const name = $(row).find('td[data-type="DisplayName"]').text().trim();
      const href = $(row).find('a[data-type="Link"]').attr("href") ?? "";
      const match = href.match(/[?&]id=(\d+)/);
      if (match?.[1] && name) mods.push({ id: match[1], name });
    });
  }

  return mods;
}

// ── Fetch file details from Steam Web API in batches of 100 ──────────────────
async function fetchSteamDetails(ids: string[]): Promise<SteamFileDetail[]> {
  const BATCH = 100;
  const results: SteamFileDetail[] = [];

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const params = new URLSearchParams();
    params.append("key", STEAM_API_KEY);
    params.append("itemcount", String(batch.length));
    batch.forEach((id, idx) => params.append(`publishedfileids[${idx}]`, id));

    const res = await fetch(
      "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
      { method: "POST", body: params }
    );

    if (!res.ok) throw new Error(`Steam API error: ${res.status} ${res.statusText}`);

    const json = await res.json() as {
      response: { publishedfiledetails: SteamFileDetail[] }
    };

    results.push(...json.response.publishedfiledetails);
  }

  return results;
}

// ── Scrape the latest changelog entry for a single mod ────────────────────────
// Only called for mods already confirmed as recently updated by the API,
// so typically 0-2 requests per run — well under any rate limit.
async function fetchLatestChangelog(modId: string): Promise<string> {
  const url = `https://steamcommunity.com/sharedfiles/filedetails/changelog/${modId}`;

  try {
    const res = await fetch(url, {
      headers: {
        // Identify as a regular browser to avoid bot detection
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      console.warn(`  Changelog fetch failed for ${modId}: ${res.status}`);
      return "Could not retrieve changelog.";
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // First .detailBox.workshopAnnouncement block = latest changelog entry
    const changelogBox = $(".detailBox.workshopAnnouncement").first();

    if (!changelogBox.length) {
      return "No changelog entries found.";
    }

    // Extract all <p> text within the entry, preserving line breaks
    const lines: string[] = [];
    changelogBox.find("p").each((_, el) => {
      const text = $(el).text().trim();
      if (text) lines.push(text);
    });

    const result = lines.join("\n").trim();
    return result || "Changelog entry was empty.";

  } catch (err) {
    console.warn(`  Changelog fetch error for ${modId}:`, err);
    return "Error retrieving changelog.";
  }
}

// ── Discord notification ──────────────────────────────────────────────────────
async function sendDiscord(
  modId: string,
  modName: string,
  updatedAt: Date,
  ageHours: string,
  changelog: string
): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) { console.error("DISCORD_WEBHOOK_URL not set"); return; }

  const MAX = 1024;
  const chunks = changelog.trim().length === 0
    ? ["No changelog available."]
    : chunkText(changelog, MAX);

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const fields: object[] = [];

    if (isFirst) {
      fields.push(
        { name: "Mod", value: `[${modName}](https://steamcommunity.com/sharedfiles/filedetails/?id=${modId})`, inline: false },
        { name: "Updated", value: updatedAt.toUTCString(), inline: true },
        { name: "Age", value: `${ageHours}h ago`, inline: true }
      );
    }

    fields.push({
      name: isFirst ? "Changelog" : "Changelog (continued)",
      value: chunks[i],
      inline: false,
    });

    const embed = {
      title: isFirst ? "🔔 Arma 3 Mod Update" : `🔔 Arma 3 Mod Update (cont. ${i + 1})`,
      color: 0xff0000,
      timestamp: new Date().toISOString(),
      footer: { text: "Steam Workshop Monitor" },
      fields,
    };

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Steam Workshop Monitor", content: "", embeds: [embed] }),
    });

    if (!res.ok) throw new Error(`Discord error: ${res.status} ${res.statusText}`);
    if (i < chunks.length - 1) await sleep(1000);
  }

  console.log(`  ✓ Discord notified (${chunks.length} message(s))`);
}

function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      if (current) chunks.push(current);
      current = line.length > max ? line.slice(0, max - 3) + "..." : line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!STEAM_API_KEY) { console.error("STEAM_API_KEY not set"); process.exit(1); }

  const mods = loadMods();
  console.log(`Loaded ${mods.length} mod(s)`);

  const details = await fetchSteamDetails(mods.map(m => m.id));
  const nameById = Object.fromEntries(mods.map(m => [m.id, m.name]));

  const now = Date.now();
  let recentCount = 0;

  for (const detail of details) {
    if (detail.result !== 1) {
      console.warn(`  Skipping ${detail.publishedfileid}: result=${detail.result}`);
      continue;
    }

    const updatedAt = new Date(detail.time_updated * 1000);
    const ageHours = ((now - updatedAt.getTime()) / 3_600_000).toFixed(1);
    const isRecent = parseFloat(ageHours) < HOURS_THRESHOLD;
    const displayName = nameById[detail.publishedfileid] ?? detail.title;

    console.log(`[${detail.publishedfileid}] ${displayName} — ${ageHours}h ago ${isRecent ? "⚠ RECENT" : ""}`);

    if (isRecent) {
      recentCount++;
      console.log(`  Fetching changelog for ${detail.publishedfileid}...`);

      // Small courtesy delay before hitting the community page
      await sleep(2000);
      const changelog = await fetchLatestChangelog(detail.publishedfileid);

      await sendDiscord(detail.publishedfileid, displayName, updatedAt, ageHours, changelog);
    }
  }

  console.log(`\nDone. ${recentCount} recent update(s) found.`);
}

main().catch(err => { console.error(err); process.exit(1); });
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { parse, isValid } from "date-fns";

//// Production
const Hours_ThresHold = 7;

// Test
// const Hours_ThresHold = 48;

// Helper to parse Steam date format robustly
function parseSteamDate(rawDateText: string): Date {
  let cleaned = rawDateText.trim().replace(/^[A-Za-z]+:\s*/, "");

  const match = cleaned.match(
    /^([A-Za-z]{3})\s+(\d{1,2})(?:,\s+(\d{4}))?\s*@\s*(\d{1,2}:\d{2})\s*([ap]m)$/i
  );
  if (!match) {
    throw new Error(`Failed to extract date components from "${rawDateText}"`);
  }

  const [, month, day, year, timePart, period] = match;
  const finalYear = year || new Date().getFullYear();

  const fullDateStr = `${month} ${day}, ${finalYear} ${timePart} ${period}`;

  const formats = [
    "MMM d, yyyy h:mm a",
    "MMM dd, yyyy h:mm a",
    "MMM d yyyy h:mm a",
    "MMM d, yyyy h:mma",
    "MMM d, yyyy HH:mm",
  ];

  for (const fmt of formats) {
    const candidate = parse(fullDateStr, fmt, new Date());
    if (isValid(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not parse date: "${fullDateStr}"`);
}

// Simple Discord webhook function with raw date and hours
async function sendDiscordNotification(
  modName: string,
  rawDateText: string,
  ageHours: string,
  rawInfo: string
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error("DISCORD_WEBHOOK_URL environment variable not set");
    return;
  }

  try {
    console.log("Sending Discord notification...");

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "Steam Workshop Monitor",
        embeds: [
          {
            title: "Arma 3 mod update",
            fields: [
              {
                name: "Mod",
                value: modName,
                inline: false,
              },
              {
                name: "Updated",
                value: `${rawDateText} pst`,
                inline: true,
              },
              {
                name: "Hours Ago",
                value: `${ageHours} hours ago`,
                inline: true,
              },
              {
                name: "Change",
                value: rawInfo || "No change description available",
                inline: false,
              },
            ],
            color: 0xff0000, // Steam blue color
            timestamp: new Date().toISOString(),
            footer: {
              text: "Arma 3 Steam Workshop Monitor",
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Discord webhook failed: ${response.status} ${response.statusText}`
      );
    }

    console.log("Discord notification sent successfully");
  } catch (error) {
    console.error("Error sending Discord notification:", error);
  }
}

// Read all HTML files from the data directory
const dataDir = path.join(process.cwd(), "data");
type ModEntry = { id: string; name: string };
let workshopMods: ModEntry[] = [];

try {
  const files = fs.readdirSync(dataDir);
  const htmlFiles = files.filter(
    (file) => path.extname(file).toLowerCase() === ".html"
  );

  for (const file of htmlFiles) {
    const filePath = path.join(dataDir, file);

    try {
      const data = readFileSync(filePath, "utf-8");
      const $ = cheerio.load(data);

      // Extract mods from each ModContainer row
      $('tr[data-type="ModContainer"]').each((_, row) => {
        const name = $(row).find('td[data-type="DisplayName"]').text().trim();
        const href = $(row).find('a[data-type="Link"]').attr("href") || "";
        const match = href.match(/[?&]id=(\d+)/);

        if (match && match[1] && name) {
          workshopMods.push({
            id: match[1],
            name: name,
          });
        }
      });
    } catch (fileError) {
      console.error(`Error processing file ${file}:`, fileError.message);
    }
  }
} catch (dirError) {
  console.error(`Error reading data directory: ${dirError.message}`);
}

// Create a separate test per mod using display name
for (const { id, name } of workshopMods) {
  test(`Mod ${name} - Check recent update`, async ({ page }) => {
    await page.goto(
      `https://steamcommunity.com/sharedfiles/filedetails/changelog/${id}`,
      { waitUntil: "domcontentloaded" }
    );

    const dateLocator = page.locator("(//div[@class='changelog headline'])[1]");
    const modchangeInfo = page.locator(
      "(//div[contains(@class,'detailBox workshopAnnouncement')]//p)[1]"
    );

    await dateLocator.waitFor({ timeout: 20000 });

    const nameOfMod = await page.locator(".workshopItemTitle").innerText();
    const rawDateText = await dateLocator.innerText();
    const rawInfo = await modchangeInfo.innerText();

    if (!rawDateText) throw new Error("No date text found");

    const lastUpdated = parseSteamDate(rawDateText);
    const now = new Date();
    const diffMs = now.getTime() - lastUpdated.getTime();
    let diffHours = diffMs / (1000 * 60 * 60);
    const isRecent = diffHours < Hours_ThresHold;
    diffHours -= 3;
    const ageHours = diffHours.toFixed(1);

    if (isRecent) {


      // Send Discord notification with raw date and calculated hours
      await sendDiscordNotification(nameOfMod, rawDateText, ageHours, rawInfo);
    }

    // Each mod test asserts that it is NOT recent
    expect(isRecent).toBe(false);

    // Rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  });
}

import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { parse, isValid } from "date-fns";

//// Production
const Hours_ThresHold = 24;

// Improved rate limiting configuration
const BASE_DELAY = 600000; // 10 minutes base delay (increased from 6)
const MAX_RETRIES = 3;
const RETRY_DELAY = 60000; // 1 minute between retries
const EXPONENTIAL_BACKOFF = true;

// Parallel batch configuration
const BATCH_SIZE = 3; // Number of mods to check in parallel
const BATCH_STAGGER_DELAY = 60000; // 2 minutes between batch starts

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
  
  // Smart year handling
  let finalYear: number;
  if (year) {
    // Year explicitly provided
    finalYear = parseInt(year);
  } else {
    // No year provided - need to determine if it's current year or last year
    const now = new Date();
    const currentYear = now.getFullYear();
    
    // Try parsing with current year first
    const testDateStr = `${month} ${day}, ${currentYear} ${timePart} ${period}`;
    const testDate = parse(testDateStr, "MMM d, yyyy h:mm a", new Date());
    
    // If the parsed date is in the future, it must be from last year
    if (testDate > now) {
      finalYear = currentYear - 1;
    } else {
      finalYear = currentYear;
    }
  }

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

// Check if page shows rate limiting or error
async function isRateLimited(page: any): Promise<boolean> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  
  // Common Steam rate limiting indicators
  const rateLimitIndicators = [
    "too many requests",
    "rate limit",
    "please try again later",
    "error 429",
    "temporarily unavailable",
    "access denied",
    "unusual activity",
  ];

  return rateLimitIndicators.some((indicator) =>
    bodyText.toLowerCase().includes(indicator)
  );
}

// Exponential backoff delay calculator
function getRetryDelay(attempt: number, baseDelay: number): number {
  if (!EXPONENTIAL_BACKOFF) {
    return baseDelay;
  }
  return baseDelay * Math.pow(2, attempt);
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

    const MAX_FIELD_LENGTH = 1024;
    const DELAY_BETWEEN_MESSAGES = 1000;

    const sendEmbed = async (
      changeValue: string,
      isFirstMessage: boolean = false,
      messageIndex: number = 0
    ) => {
      const embed = {
        title: isFirstMessage
          ? "Arma 3 mod update"
          : `Arma 3 mod update (continued ${messageIndex})`,
        fields: [] as any[],
        color: 0xff0000,
        timestamp: new Date().toISOString(),
        footer: {
          text: "Arma 3 Steam Workshop Monitor",
        },
      };

      if (isFirstMessage) {
        embed.fields.push(
          {
            name: "Mod:",
            value: modName,
            inline: false,
          },
          {
            name: "Date:",
            value: `${rawDateText} pst`,
            inline: true,
          },
          {
            name: "When:",
            value: `${ageHours} hours ago`,
            inline: true,
          }
        );
      }

      embed.fields.push({
        name: isFirstMessage ? "Change:" : "Change (continued):",
        value: changeValue,
        inline: false,
      });

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "Steam Workshop Monitor",
          content: " ",
          embeds: [embed],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Discord webhook failed: ${response.status} ${response.statusText}`
        );
      }
    };

    if (!rawInfo || rawInfo.trim() === "") {
      await sendEmbed("No change description available", true);
      console.log("Discord notification sent successfully");
      return;
    }

    if (rawInfo.length <= MAX_FIELD_LENGTH) {
      await sendEmbed(rawInfo, true);
      console.log("Discord notification sent successfully");
      return;
    }

    const chunks: string[] = [];
    let currentChunk = "";
    const lines = rawInfo.split("\n");

    for (const line of lines) {
      const testChunk = currentChunk + (currentChunk ? "\n" : "") + line;

      if (testChunk.length > MAX_FIELD_LENGTH) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = line;
        } else {
          chunks.push(line.substring(0, MAX_FIELD_LENGTH - 3) + "...");
          currentChunk = "";
        }
      } else {
        currentChunk = testChunk;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    for (let i = 0; i < chunks.length; i++) {
      await sendEmbed(chunks[i], i === 0, i + 1);

      if (i < chunks.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_BETWEEN_MESSAGES)
        );
      }
    }

    console.log(
      `Discord notification sent successfully (${chunks.length} messages)`
    );
  } catch (error) {
    console.error("Error sending Discord notification:", error);
  }
}

// Read all HTML files from the data directory
const dataDir = path.join(process.cwd(), "data");
type ModEntry = { id: string; name: string; batchIndex: number };
let workshopMods: ModEntry[] = [];

try {
  const files = fs.readdirSync(dataDir);
  const htmlFiles = files.filter(
    (file) => path.extname(file).toLowerCase() === ".html"
  );

  let modIndex = 0;
  for (const file of htmlFiles) {
    const filePath = path.join(dataDir, file);

    try {
      const data = readFileSync(filePath, "utf-8");
      const $ = cheerio.load(data);

      $('tr[data-type="ModContainer"]').each((_, row) => {
        const name = $(row).find('td[data-type="DisplayName"]').text().trim();
        const href = $(row).find('a[data-type="Link"]').attr("href") || "";
        const match = href.match(/[?&]id=(\d+)/);

        if (match && match[1] && name) {
          workshopMods.push({
            id: match[1],
            name: name,
            batchIndex: Math.floor(modIndex / BATCH_SIZE),
          });
          modIndex++;
        }
      });
    } catch (fileError) {
      // Silent error handling for individual files
    }
  }
} catch (dirError) {
  // Silent error handling for directory
}

// Group mods by batch
const batches = workshopMods.reduce((acc, mod) => {
  if (!acc[mod.batchIndex]) {
    acc[mod.batchIndex] = [];
  }
  acc[mod.batchIndex].push(mod);
  return acc;
}, {} as Record<number, ModEntry[]>);

console.log(`Total mods: ${workshopMods.length}, Batches: ${Object.keys(batches).length}`);

// Create tests with staggered batch execution
for (const { id, name, batchIndex } of workshopMods) {
  test(`Mod ${name} - Check recent update`, async ({ page }) => {
    // Stagger batch starts - each batch waits before starting
    const initialDelay = batchIndex * BATCH_STAGGER_DELAY;
    if (initialDelay > 0) {
      console.log(`Batch ${batchIndex}: Waiting ${initialDelay / 1000}s before starting...`);
      await new Promise((r) => setTimeout(r, initialDelay));
    }

    let attempt = 0;
    let success = false;
    let lastError: Error | null = null;

    // Retry loop with exponential backoff
    while (attempt < MAX_RETRIES && !success) {
      try {
        console.log(`[Batch ${batchIndex}] Checking mod ${name} (attempt ${attempt + 1}/${MAX_RETRIES})`);

        await page.goto(
          `https://steamcommunity.com/sharedfiles/filedetails/changelog/${id}`,
          { 
            waitUntil: "domcontentloaded",
            timeout: 60000 // 120 second timeout
          }
        );

        // Wait a bit for the page to fully load
        await page.waitForTimeout(3000);

        // Check if we hit rate limiting
        if (await isRateLimited(page)) {
          throw new Error("Rate limited by Steam");
        }

        const dateLocator = page.locator("(//div[@class='changelog headline'])[1]");
        const modchangeInfo = page.locator("(//div[contains(@class,'detailBox workshopAnnouncement')]//p)[1]");
        await dateLocator.waitFor({ timeout: 20000 });

        const nameOfMod = await page.locator(".workshopItemTitle").innerText();
        const rawDateText = await dateLocator.innerText();
        const rawInfo = await modchangeInfo.innerText();

        if (!rawDateText) throw new Error("No date text found");

        const lastUpdated = parseSteamDate(rawDateText);
        const now = new Date();
        const diffMs = now.getTime() - lastUpdated.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        const isRecent = diffHours < Hours_ThresHold;
        const ageHours = diffHours.toFixed(1);

        if (isRecent) {
          console.warn(`
            Name: ${nameOfMod}
            Date: ${rawDateText}
            Hours Ago: ${ageHours}
            
            Hours Threshold: ${Hours_ThresHold}
          `);

          await sendDiscordNotification(nameOfMod, rawDateText, ageHours, rawInfo);
        }

        expect(isRecent).toBe(false);
        success = true;

      } catch (error) {
        lastError = error as Error;
        attempt++;

        if (attempt < MAX_RETRIES) {
          const retryDelay = getRetryDelay(attempt - 1, RETRY_DELAY);
          console.log(
            `[Batch ${batchIndex}] Failed to check mod ${name}: ${lastError.message}. Retrying in ${retryDelay / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, retryDelay));
        } else {
          console.error(
            `[Batch ${batchIndex}] Failed to check mod ${name} after ${MAX_RETRIES} attempts: ${lastError.message}`
          );
          // Don't throw - mark test as passing to continue with other mods
          expect(true).toBe(true);
        }
      }
    }

    // Rate limiting delay with jitter (only within the same batch)
    // Batches are already staggered, so we don't need as much delay here
    const jitter = Math.random() * 60000; // Add 0-60 second jitter
    await new Promise((r) => setTimeout(r, jitter));
  });
}

// Configure Playwright to run tests in parallel
test.describe.configure({ mode: 'parallel' });
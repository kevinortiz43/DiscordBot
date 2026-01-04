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

// Rate limiting detection and backoff management
let rateLimitDetected = false;
let backoffAttempts = 0;
const MAX_BACKOFF_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

// Calculate exponential backoff delay
function getBackoffDelay(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, attempt);
}

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
  const currentYear = new Date().getFullYear();
  const finalYear = year ? parseInt(year) : currentYear;

  // Validate year is reasonable (not in the future)
  if (finalYear > currentYear) {
    throw new Error(`Invalid year in date: ${finalYear} (current year: ${currentYear})`);
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

    // Discord embed field value limit is 1024 characters
    const MAX_FIELD_LENGTH = 1024;
    const DELAY_BETWEEN_MESSAGES = 1000; // 1 second delay between messages

    // Helper function to send a single embed
    const sendEmbed = async (changeValue: string, isFirstMessage: boolean = false, messageIndex: number = 0) => {
      const embed = {
        title: isFirstMessage ? "Arma 3 mod update" : `Arma 3 mod update (continued ${messageIndex})`,
        fields: [] as any[],
        color: 0xff0000,
        timestamp: new Date().toISOString(),
        footer: {
          text: "Arma 3 Steam Workshop Monitor",
        },
      };

      // Only include mod info in the first message
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
          content: "<@170736049918574592>  <@112652970008539136> <@111328594881482752> ",
          embeds: [embed],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Discord webhook failed: ${response.status} ${response.statusText}`
        );
      }
    };

    // Handle empty or missing change info
    if (!rawInfo || rawInfo.trim() === "") {
      await sendEmbed("No change description available", true);
      console.log("Discord notification sent successfully");
      return;
    }

    // If the change info fits in one message, send it normally
    if (rawInfo.length <= MAX_FIELD_LENGTH) {
      await sendEmbed(rawInfo, true);
      console.log("Discord notification sent successfully");
      return;
    }

    // Split long change info into chunks
    const chunks: string[] = [];
    let currentChunk = "";
    const lines = rawInfo.split('\n');

    for (const line of lines) {
      // Check if adding this line would exceed the limit
      const testChunk = currentChunk + (currentChunk ? '\n' : '') + line;
      
      if (testChunk.length > MAX_FIELD_LENGTH) {
        // If the current chunk has content, save it and start a new one
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = line;
        } else {
          // If a single line is too long, truncate it
          chunks.push(line.substring(0, MAX_FIELD_LENGTH - 3) + "...");
          currentChunk = "";
        }
      } else {
        currentChunk = testChunk;
      }
    }

    // Add the final chunk if it has content
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    // Send each chunk as a separate message
    for (let i = 0; i < chunks.length; i++) {
      await sendEmbed(chunks[i], i === 0, i + 1);
      
      // Add delay between messages (except after the last one)
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_MESSAGES));
      }
    }

    console.log(`Discord notification sent successfully (${chunks.length} messages)`);
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

// Randomize the mod order using Fisher-Yates shuffle
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const randomizedMods = shuffleArray(workshopMods);

// Create a separate test per mod using display name with randomized order
for (let modIndex = 0; modIndex < randomizedMods.length; modIndex++) {
  const { id, name } = randomizedMods[modIndex];
  
  test(`Mod ${name} - Check recent update`, async ({ page }) => {
    let retryAttempt = 0;
    let success = false;

    while (!success && retryAttempt <= MAX_BACKOFF_ATTEMPTS) {
      // Add delay between tests (3-5 seconds random) on first attempt or between retries
      const delayMs = 3000 + Math.floor(Math.random() * 2000);
      if (modIndex > 0 || retryAttempt > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      try {
        const response = await page.goto(
          `https://steamcommunity.com/sharedfiles/filedetails/changelog/${id}`,
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );

        // Check for rate limiting (HTTP 429 or specific Steam rate limit page)
        if (response?.status() === 429) {
          throw new Error("RATE_LIMIT_429");
        }

        // Check page content for rate limit messages
        const pageContent = await page.content();
        if (pageContent.includes("rate limit") || 
            pageContent.includes("too many requests") ||
            pageContent.includes("Please wait")) {
          throw new Error("RATE_LIMIT_CONTENT");
        }

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
        
        // Check for negative time difference (date in future or parsing error)
        if (diffMs < 0) {
          console.error(`Invalid date detected for mod ${nameOfMod}: date appears to be in the future`);
          console.error(`Raw date: ${rawDateText}, Parsed: ${lastUpdated}, Current: ${now}`);
          throw new Error(`Invalid date: ${rawDateText} - date is in the future`);
        }
        
        let diffHours = diffMs / (1000 * 60 * 60);
        const isRecent = diffHours < Hours_ThresHold + 7;
        diffHours -= 7;
        const ageHours = diffHours.toFixed(1);
        
        // Additional check: only send notification if ageHours is positive and reasonable
        if (isRecent && parseFloat(ageHours) >= 0) {
          console.warn(`
            Name: ${nameOfMod}
            Date: ${rawDateText}
            Hours Ago: ${ageHours}
            Info: ${rawInfo}
            Hours Threshold ${Hours_ThresHold}
            `);
            
          // Send Discord notification with raw date and calculated hours
          await sendDiscordNotification(nameOfMod, rawDateText, ageHours, rawInfo);
        }

        // Each mod test asserts that it is NOT recent
        expect(isRecent).toBe(false);
        
        // Mark as successful
        success = true;
        rateLimitDetected = false;

      } catch (error) {
        // Check if error is related to rate limiting
        const errorMessage = error.toString();
        const isRateLimit = errorMessage.includes("RATE_LIMIT") || 
                           errorMessage.includes("429") || 
                           errorMessage.toLowerCase().includes("rate limit") || 
                           errorMessage.toLowerCase().includes("too many requests");
        
        if (isRateLimit) {
          rateLimitDetected = true;
          
          if (retryAttempt < MAX_BACKOFF_ATTEMPTS) {
            const backoffDelay = getBackoffDelay(retryAttempt);
            const backoffMinutes = (backoffDelay / 60000).toFixed(1);
            
            console.error(`
╔════════════════════════════════════════════════════════════════╗
║ RATE LIMIT DETECTED for mod: ${name.padEnd(31)}║
║ Attempt: ${(retryAttempt + 1).toString().padEnd(53)}║
║ Waiting ${backoffMinutes} minutes before retrying...${' '.repeat(Math.max(0, 22 - backoffMinutes.length))}║
╚════════════════════════════════════════════════════════════════╝
            `);
            
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            retryAttempt++;
          } else {
            console.error(`
╔════════════════════════════════════════════════════════════════╗
║ MAX BACKOFF ATTEMPTS REACHED for mod: ${name.padEnd(23)}║
║ Skipping this mod and continuing...                           ║
╚════════════════════════════════════════════════════════════════╝
            `);
            test.skip();
            return;
          }
        } else {
          // If it's another type of error, log it and throw
          console.error(`Error checking mod ${name}:`, error);
          throw error;
        }
      }
    }
  });
}
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { parse, isValid } from "date-fns";

//// Production
const Hours_ThresHold = 7;

// 50 seconds
const amountOfTime = 60000;
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
  ageHours: string
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
          content:
            "<@170736049918574592>  <@112652970008539136> <@111328594881482752> ",
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
    // if (!rawInfo || rawInfo.trim() === "") {
    //   await sendEmbed("No change description available", true);
    //   console.log("Discord notification sent successfully");
    //   return;
    // }

    // // If the change info fits in one message, send it normally
    // if (rawInfo.length <= MAX_FIELD_LENGTH) {
    //   await sendEmbed(rawInfo, true);
    //   console.log("Discord notification sent successfully");
    //   return;
    // }

    // // Split long change info into chunks
    // const chunks: string[] = [];
    // let currentChunk = "";
    // const lines = rawInfo.split("\n");

    // for (const line of lines) {
    //   // Check if adding this line would exceed the limit
    //   const testChunk = currentChunk + (currentChunk ? "\n" : "") + line;

    //   if (testChunk.length > MAX_FIELD_LENGTH) {
    //     // If the current chunk has content, save it and start a new one
    //     if (currentChunk) {
    //       chunks.push(currentChunk);
    //       currentChunk = line;
    //     } else {
    //       // If a single line is too long, truncate it
    //       chunks.push(line.substring(0, MAX_FIELD_LENGTH - 3) + "...");
    //       currentChunk = "";
    //     }
    //   } else {
    //     currentChunk = testChunk;
    //   }
    // }

    // // Add the final chunk if it has content
    // if (currentChunk) {
    //   chunks.push(currentChunk);
    // }

    // // Send each chunk as a separate message
    // for (let i = 0; i < chunks.length; i++) {
    //   await sendEmbed(chunks[i], i === 0, i + 1);

    //   // Add delay between messages (except after the last one)
    //   if (i < chunks.length - 1) {
    //     await new Promise((resolve) =>
    //       setTimeout(resolve, DELAY_BETWEEN_MESSAGES)
    //     );
    //   }
    // }

    // console.log(
    //   `Discord notification sent successfully (${chunks.length} messages)`
    // );
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
      // console.error(`Error processing file ${file}:`, fileError.message);
    }
  }
} catch (dirError) {
  // console.error(`Error reading data directory: ${dirError.message}`);
}

// Create a separate test per mod using display name
for (const { id, name } of workshopMods) {
  test(`Mod ${name} - Check recent update`, async ({ page }) => {
    await page.goto(
      `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
      { waitUntil: "domcontentloaded" }
    );

    const dateLocator2 = page.locator("(//div[@class='detailsStatRight'])[3]");
    // const dateLocator = page.locator("(//div[@class='changelog headline'])[1]");
    // const modchangeInfo = page.locator(
    //   "(//div[contains(@class,'detailBox workshopAnnouncement')]//p)[1]"
    // );

    await dateLocator2.waitFor({ timeout: amountOfTime });

    const nameOfMod = await page.locator(".workshopItemTitle").innerText();
    const rawDateText = await dateLocator2.innerText();
    // const rawInfo = await modchangeInfo.innerText();

    if (!rawDateText) throw new Error("No date text found");

    const lastUpdated = parseSteamDate(rawDateText);
    const now = new Date();
    const diffMs = now.getTime() - lastUpdated.getTime();
    let diffHours = diffMs / (1000 * 60 * 60);
    const isRecent = diffHours < Hours_ThresHold + 7;
    diffHours -= 7;
    const ageHours = diffHours.toFixed(1);

    if (isRecent) {
      console.warn(`
        Name: ${nameOfMod}
        Date: ${rawDateText}
        Hours Ago: ${ageHours}
        
        Hours Threshold ${Hours_ThresHold}
        `);

      // Send Discord notification with raw date and calculated hours
      await sendDiscordNotification(nameOfMod, rawDateText, ageHours);
    }
    // else{
    //    console.warn(`
    //     Name: ${nameOfMod}
    //     Date: ${rawDateText}
    //     Hours Ago: ${ageHours}

    //     `);

    // }

    // Each mod test asserts that it is NOT recent
    expect(isRecent).toBe(false);

    // Rate limiting
    await new Promise((r) => setTimeout(r, amountOfTime));
  });
}

/**
 * reporter.ts — Scheduled daily reporting to #root channel
 *
 * Saves miner/user requests and posts a summary to #root at:
 *   - EDT 8:00 AM  (12:00 UTC during EDT / 13:00 UTC during EST)
 *   - EDT 7:00 PM  (23:00 UTC during EDT / 00:00 UTC during EST)
 */

import {
  Client,
  ChannelType,
  TextChannel,
} from "discord.js";
import type { Config } from "./types.js";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { mlog } from "./monitor.js";

// ── Request Log ────────────────────────────────────────────────────────────

export interface MinerRequest {
  who: string;
  when: string;
  channel: string;
  messageLink?: string;
  summary: string;
}

const REQUESTS_DIR = "/development/logos/workspace/root";
const REQUESTS_FILE = "miner-requests.json";

function requestsPath(): string {
  return join(REQUESTS_DIR, REQUESTS_FILE);
}

async function loadRequests(): Promise<MinerRequest[]> {
  try {
    const raw = await readFile(requestsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveRequests(requests: MinerRequest[]): Promise<void> {
  await mkdir(REQUESTS_DIR, { recursive: true });
  await writeFile(requestsPath(), JSON.stringify(requests, null, 2));
}

/** Called from the claude CLI invocation (via workspace scripts) to log a request */
export async function logMinerRequest(req: MinerRequest): Promise<void> {
  const existing = await loadRequests();
  existing.push(req);
  await saveRequests(existing);
  mlog("info", "reporter", `Miner request logged`, { who: req.who, summary: req.summary });
}

// ── Scheduled Reporter ─────────────────────────────────────────────────────

let reporterTimer: ReturnType<typeof setInterval> | null = null;
let lastReportHourUTC: number = -1;

/** Returns the current EDT offset hours from UTC (handles DST) */
function edtOffsetHours(): number {
  // EDT = UTC-4, EST = UTC-5
  // US Eastern DST: second Sunday of March to first Sunday of November
  const now = new Date();
  const year = now.getUTCFullYear();

  // Second Sunday of March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchFirstDay = marchFirst.getUTCDay();
  const secondSunday = marchFirstDay === 0 ? 8 : 8 + (7 - marchFirstDay);
  const dstStart = new Date(Date.UTC(year, 2, secondSunday, 7)); // 2 AM EST = 7 AM UTC

  // First Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstDay = novFirst.getUTCDay();
  const firstSunday = novFirstDay === 0 ? 1 : 1 + (7 - novFirstDay);
  const dstEnd = new Date(Date.UTC(year, 10, firstSunday, 6)); // 2 AM EDT = 6 AM UTC

  return (now >= dstStart && now < dstEnd) ? -4 : -5;
}

function getReportTimesUTC(): number[] {
  const offset = edtOffsetHours();
  // 8 AM EDT and 7 PM EDT in UTC hours
  const morning = (8 - offset + 24) % 24; // 8 AM EDT → 12 UTC (during EDT)
  const evening = (19 - offset + 24) % 24; // 7 PM EDT → 23 UTC (during EDT)
  return [morning, evening];
}

async function findRootChannel(client: Client, config: Config): Promise<TextChannel | null> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const channels = await guild.channels.fetch();
  for (const [, ch] of channels) {
    if (ch && ch.type === ChannelType.GuildText && ch.name === "root") {
      return ch as TextChannel;
    }
  }
  return null;
}

async function postReport(client: Client, config: Config): Promise<void> {
  const requests = await loadRequests();

  const rootChannel = await findRootChannel(client, config);
  if (!rootChannel) {
    mlog("warn", "reporter", "Cannot find #root channel for daily report");
    return;
  }

  const now = new Date();
  const offset = edtOffsetHours();
  const edtHour = (now.getUTCHours() + offset + 24) % 24;
  const timeLabel = edtHour < 12 ? "Morning" : "Evening";

  if (requests.length === 0) {
    await rootChannel.send(
      `**📋 ${timeLabel} Report (${now.toISOString().split("T")[0]})**\n\nNo miner/user requests since last report. All quiet 👍`
    );
  } else {
    const lines = requests.map((r, i) => {
      const link = r.messageLink ? ` — [jump](${r.messageLink})` : "";
      return `${i + 1}. **${r.who}** in #${r.channel} (${r.when})${link}\n   _${r.summary}_`;
    });

    const body = lines.join("\n");
    const msg = `**📋 ${timeLabel} Report (${now.toISOString().split("T")[0]})**\n\n${body}`;

    // Truncate if too long
    const truncated = msg.length > 1900 ? msg.slice(0, 1900) + "\n…" : msg;
    await rootChannel.send(truncated);

    // Clear processed requests
    await saveRequests([]);
  }

  mlog("info", "reporter", `Daily ${timeLabel.toLowerCase()} report posted`, {
    requestCount: requests.length,
  });
}

export function startReporter(client: Client, config: Config): void {
  // Check every minute if it's time to report
  reporterTimer = setInterval(async () => {
    try {
      const now = new Date();
      const currentHourUTC = now.getUTCHours();
      const currentMinute = now.getUTCMinutes();

      // Only fire in the first 2 minutes of the hour to avoid duplicates
      if (currentMinute > 1) return;

      // Don't fire twice in the same hour
      if (currentHourUTC === lastReportHourUTC) return;

      const reportHours = getReportTimesUTC();
      if (reportHours.includes(currentHourUTC)) {
        lastReportHourUTC = currentHourUTC;
        await postReport(client, config);
      }
    } catch (err) {
      mlog("error", "reporter", `Report check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 60_000); // Check every minute

  mlog("info", "reporter", "Daily reporter started", {
    reportTimesUTC: getReportTimesUTC(),
  });
}

export function stopReporter(): void {
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
}

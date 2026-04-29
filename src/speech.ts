import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { mlog } from "./monitor.js";

const execFileAsync = promisify(execFile);

// ── Speech busy lock ──────────────────────────────────────────────────────
let _speechBusy = false;
export function isSpeechBusy(): boolean { return _speechBusy; }
export function setSpeechBusy(v: boolean): void { _speechBusy = v; }

const TTS_BASE_URL = "http://149.36.0.184:8088";
const TTS_TOKEN = "logos_bot_token";
const TTS_TIMEOUT_MS = 50_000; // 50 seconds overall timeout
const TTS_CONNECT_TIMEOUT_MS = 50_000;
const MAX_SPEECH_WORDS = 80;
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`]+`/g;
const MATH_LINE_REGEX = /^\s*[\$\\].*[\$\\]\s*$/gm;

// ── Speech-friendliness check ──────────────────────────────────────────────

export interface SpeechCheck {
  ok: boolean;
  reason?: string;
}

export function checkSpeechFriendly(text: string): SpeechCheck {
  // Count code blocks (multi-line)
  const codeBlocks = text.match(CODE_BLOCK_REGEX);
  if (codeBlocks && codeBlocks.length >= 2) {
    return { ok: false, reason: "Response contains multiple code blocks — not great for audio." };
  }
  if (codeBlocks) {
    const totalCodeLines = codeBlocks.reduce((sum, block) => {
      return sum + block.split("\n").length;
    }, 0);
    if (totalCodeLines > 6) {
      return { ok: false, reason: "Response contains lengthy code blocks — not suitable for speech." };
    }
  }

  // Check for heavy math notation
  const mathLines = text.match(MATH_LINE_REGEX);
  if (mathLines && mathLines.length >= 3) {
    return { ok: false, reason: "Response contains math notation — not suitable for speech." };
  }

  // Word count check (strip code blocks and inline code first)
  const stripped = text
    .replace(CODE_BLOCK_REGEX, "")
    .replace(INLINE_CODE_REGEX, "")
    .trim();
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_SPEECH_WORDS) {
    return { ok: false, reason: `Response is ${wordCount} words (limit: ${MAX_SPEECH_WORDS}) — too long for speech.` };
  }

  return { ok: true };
}

// ── Text sanitization for TTS ──────────────────────────────────────────────

export function sanitizeForTTS(text: string): string {
  let clean = text;

  // Remove markdown formatting
  clean = clean.replace(CODE_BLOCK_REGEX, ""); // remove code blocks
  clean = clean.replace(INLINE_CODE_REGEX, (m) => m.slice(1, -1)); // unwrap inline code
  clean = clean.replace(/\*\*(.+?)\*\*/g, "$1"); // bold
  clean = clean.replace(/\*(.+?)\*/g, "$1"); // italic
  clean = clean.replace(/__(.+?)__/g, "$1"); // underline
  clean = clean.replace(/_(.+?)_/g, "$1"); // italic
  clean = clean.replace(/~~(.+?)~~/g, "$1"); // strikethrough
  clean = clean.replace(/^#{1,6}\s+/gm, ""); // headings
  clean = clean.replace(/^[-*]\s+/gm, ""); // list items
  clean = clean.replace(/^\d+\.\s+/gm, ""); // numbered lists
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links
  clean = clean.replace(/^>\s+/gm, ""); // blockquotes

  // Collapse whitespace
  clean = clean.replace(/\n{3,}/g, "\n\n");
  clean = clean.trim();

  return clean;
}

// ── TTS endpoint call ──────────────────────────────────────────────────────

export async function generateSpeech(text: string, outputDir: string, endpoint: VoiceEndpoint = "clone_const"): Promise<string | null> {
  const sanitized = sanitizeForTTS(text);
  if (!sanitized) {
    mlog("warn", "speech", "Nothing to speak after sanitization");
    return null;
  }

  const url = `${TTS_BASE_URL}/${endpoint}`;
  const params = new URLSearchParams({
    text: sanitized,
    output_format: "ogg",
  });

  mlog("info", "speech", "Calling TTS endpoint", {
    textLength: sanitized.length,
    textPreview: sanitized.slice(0, 100),
  });

  try {
    const controller = new AbortController();
    const connectTimeout = setTimeout(() => controller.abort(), TTS_CONNECT_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Token": TTS_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: controller.signal,
    });

    clearTimeout(connectTimeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      mlog("error", "speech", `TTS endpoint returned ${response.status}`, { body: errText.slice(0, 200) });
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ts = Date.now();
    const rawPath = join(outputDir, `voice_raw_${ts}.ogg`);
    const filepath = join(outputDir, `voice_${ts}.ogg`);

    // Write raw TTS output (Vorbis)
    await writeFile(rawPath, buffer);

    // Convert to OGG Opus — Discord voice messages require Opus codec
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-i", rawPath,
        "-c:a", "libopus",
        "-b:a", "48k",
        "-ar", "48000",
        "-ac", "1",
        filepath,
      ]);
      // Clean up raw file
      await unlink(rawPath).catch(() => {});
      mlog("info", "speech", `Speech generated (opus)`, { filepath, rawBytes: buffer.length });
    } catch (convErr) {
      mlog("error", "speech", `Opus conversion failed — cannot send voice message`, {
        error: convErr instanceof Error ? convErr.message : String(convErr),
      });
      await unlink(rawPath).catch(() => {});
      return null;
    }

    return filepath;
  } catch (err) {
    mlog("error", "speech", `TTS call failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Audio metadata for Discord voice messages ────────────────────────────

export interface VoiceMetadata {
  durationSecs: number;
  waveform: string; // base64-encoded
}

export async function getVoiceMetadata(filepath: string): Promise<VoiceMetadata> {
  // Get duration via ffprobe
  const { stdout: durOut } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filepath,
  ]);
  const durationSecs = parseFloat(durOut.trim()) || 1;

  // Generate waveform: extract raw PCM, downsample to ~256 samples, encode as base64
  // Discord expects a base64 string of byte values (0-255) representing amplitude
  const { stdout: pcmOut } = await execFileAsync("ffmpeg", [
    "-i", filepath,
    "-ac", "1",           // mono
    "-ar", "256",         // ~256 samples per second (we just need ~256 total samples)
    "-t", String(durationSecs),
    "-f", "u8",           // unsigned 8-bit PCM
    "-acodec", "pcm_u8",
    "pipe:1",
  ], { encoding: "buffer" as any, maxBuffer: 1024 * 1024 });

  // Take up to 256 evenly-spaced samples from the PCM data
  const raw = pcmOut as unknown as Buffer;
  const sampleCount = Math.min(256, raw.length);
  const step = Math.max(1, Math.floor(raw.length / sampleCount));
  const samples = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = raw[Math.min(i * step, raw.length - 1)];
  }

  const waveform = samples.toString("base64");
  mlog("info", "speech", "Voice metadata extracted", { durationSecs, waveformLen: waveform.length });
  return { durationSecs, waveform };
}

// ── Cleanup ────────────────────────────────────────────────────────────────

export async function cleanupSpeechFile(filepath: string): Promise<void> {
  try {
    await unlink(filepath);
  } catch {
    // ignore — file may already be gone
  }
}

// ── Voice endpoint mapping ────────────────────────────────────────────────

export type VoiceEndpoint = "clone_const" | "clone_assistant" | "clone_mark" | "clone_nova" | "clone_joker";

const PREFIX_TO_ENDPOINT: Record<string, VoiceEndpoint> = {
  "/speak_const": "clone_const",
  "/speak_nova": "clone_nova",
  "/speak_mark": "clone_mark",
};

export interface SpeakParsed {
  isSpeak: boolean;
  text: string;
  /** null means auto-detect (assistant vs joker) based on tone */
  endpoint: VoiceEndpoint | null;
}

// ── Prefix detection ───────────────────────────────────────────────────────

export function stripSpeakPrefix(content: string): SpeakParsed {
  // Check specific voice prefixes first (longest match first)
  for (const [prefix, endpoint] of Object.entries(PREFIX_TO_ENDPOINT)) {
    const regex = new RegExp(`^\\s*${prefix.replace("/", "\\/")}\\s+([\\s\\S]*)$`, "i");
    const match = content.match(regex);
    if (match) {
      return { isSpeak: true, text: match[1].trim(), endpoint };
    }
  }

  // Plain /speak — auto-detect voice
  const match = content.match(/^\s*\/speak\s+([\s\S]*)$/i);
  if (match) {
    return { isSpeak: true, text: match[1].trim(), endpoint: null };
  }

  return { isSpeak: false, text: content, endpoint: null };
}

// ── Tone detection for auto voice selection ───────────────────────────────

const JOKER_SIGNALS = /😂|😎|🤣|💀|😅|😆|🔥|lol|lmao|haha|joke|funny|hilarious|rofl|bruh|no cap|deadass|vibes|slay|🤡|👀|😜|😝|🫠/i;

export function detectVoiceEndpoint(responseText: string): VoiceEndpoint {
  // Count joker signals in the response
  const matches = responseText.match(new RegExp(JOKER_SIGNALS.source, "gi"));
  const jokerScore = matches ? matches.length : 0;

  // If 2+ joker signals, it's a playful response → joker voice
  if (jokerScore >= 2) {
    return "clone_joker";
  }

  return "clone_assistant";
}

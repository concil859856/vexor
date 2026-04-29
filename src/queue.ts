import {
  Client,
  TextChannel,
  ThreadChannel,
  Message,
  MessageFlags,
  AttachmentBuilder,
  DiscordAPIError,
  Routes,
} from "discord.js";
import { readFile } from "fs/promises";
import { getVoiceMetadata } from "./speech.js";

const MAX_MSG_LEN = 2000;
const SAFE_MSG_LEN = 1900;
const MIN_EDIT_INTERVAL_MS = 2000;
const MIN_EDIT_CHARS = 500;
const GLOBAL_RATE_LIMIT = 45; // stay under Discord's 50/s
const BUCKET_REFILL_MS = 1000;

interface PendingOp {
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class DiscordSendQueue {
  private client: Client;
  private channelQueues = new Map<string, PendingOp[]>();
  private processing = new Set<string>();
  private tokens = GLOBAL_RATE_LIMIT;
  private refillTimer: ReturnType<typeof setInterval>;

  constructor(client: Client) {
    this.client = client;
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(GLOBAL_RATE_LIMIT, this.tokens + GLOBAL_RATE_LIMIT);
    }, BUCKET_REFILL_MS);
  }

  destroy() {
    clearInterval(this.refillTimer);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async sendVoiceMessage(channelId: string, filePath: string, replyTo?: string): Promise<Message> {
    const meta = await getVoiceMetadata(filePath);
    const fileData = await readFile(filePath);

    return this.enqueue(channelId, async () => {
      const body: Record<string, any> = {
        flags: MessageFlags.IsVoiceMessage,
        attachments: [{
          id: "0",
          filename: "voice-message.ogg",
          duration_secs: meta.durationSecs,
          waveform: meta.waveform,
        }],
      };
      if (replyTo) {
        body.message_reference = { message_id: replyTo };
      }

      const result = await this.client.rest.post(
        Routes.channelMessages(channelId),
        {
          body,
          files: [{
            name: "voice-message.ogg",
            data: fileData,
            contentType: "audio/ogg; codecs=opus",
          }],
        }
      ) as any;

      const channel = await this.resolveChannel(channelId);
      return channel.messages.fetch(result.id);
    });
  }

  async send(channelId: string, content: string, replyTo?: string): Promise<Message> {
    const channel = await this.resolveChannel(channelId);
    const chunks = splitMessage(content);
    let lastMsg!: Message;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Only reply-reference the first chunk
      if (i === 0 && replyTo) {
        lastMsg = await this.enqueue(channelId, () =>
          channel.send({ content: chunk, reply: { messageReference: replyTo } })
        );
      } else {
        lastMsg = await this.enqueue(channelId, () => channel.send(chunk));
      }
    }
    return lastMsg;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await this.resolveChannel(channelId);
    const truncated = content.slice(0, MAX_MSG_LEN);
    await this.enqueue(channelId, async () => {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(truncated);
    });
  }

  /**
   * Creates a streaming session: sends a placeholder, then returns helpers
   * to push chunks and finalize.
   */
  async createStream(channelId: string, replyTo?: string): Promise<StreamHandle> {
    const placeholder = await this.send(channelId, "_Logos is thinking…_", replyTo);
    return new StreamHandle(this, channelId, placeholder);
  }

  // ── Internal queue machinery ──────────────────────────────────────────────

  private enqueue<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.channelQueues.get(channelId) ?? [];
      queue.push({
        execute: async () => {
          const result = await fn();
          (resolve as (v: unknown) => void)(result);
        },
        resolve: () => {},
        reject,
      });
      this.channelQueues.set(channelId, queue);
      this.drain(channelId);
    });
  }

  private async drain(channelId: string) {
    if (this.processing.has(channelId)) return;
    this.processing.add(channelId);

    try {
      while (true) {
        const queue = this.channelQueues.get(channelId);
        if (!queue || queue.length === 0) break;
        const op = queue.shift()!;

        await this.waitForToken();
        try {
          await op.execute();
        } catch (err) {
          if (err instanceof DiscordAPIError && err.status === 429) {
            const retryAfter = (err as any).retryAfter ?? 5;
            console.warn(`[queue] 429 on ${channelId}, backing off ${retryAfter}s`);
            await this.backoff(retryAfter * 1000);
            try {
              await op.execute();
            } catch (retryErr) {
              op.reject(retryErr);
            }
          } else {
            op.reject(err);
          }
        }
      }
    } finally {
      this.processing.delete(channelId);
    }
  }

  private async waitForToken() {
    while (this.tokens <= 0) {
      await sleep(50);
    }
    this.tokens--;
  }

  private async backoff(baseMs: number) {
    const jitter = Math.random() * baseMs * 0.5;
    await sleep(baseMs + jitter);
  }

  private async resolveChannel(id: string): Promise<TextChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(id);
    if (!ch || (!ch.isTextBased())) throw new Error(`Channel ${id} not text-based`);
    return ch as TextChannel | ThreadChannel;
  }
}

// ── StreamHandle ────────────────────────────────────────────────────────────

export class StreamHandle {
  private queue: DiscordSendQueue;
  private channelId: string;
  private messages: Message[] = [];
  private buffer = "";
  private lastFlush = Date.now();
  private editFailed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activity: string | null = null;

  constructor(queue: DiscordSendQueue, channelId: string, placeholder: Message) {
    this.queue = queue;
    this.channelId = channelId;
    this.messages = [placeholder];
  }

  setActivity(activity: string | null) {
    const prev = this.activity;
    this.activity = activity;

    // If no text output yet, show activity as the message content
    if (!this.buffer && activity) {
      this.editLatest(`_${activity}_`);
    } else if (this.buffer && activity && activity !== prev) {
      // Re-flush with new activity footer
      this.flush();
    }
  }

  push(chunk: string) {
    this.buffer += chunk;
    const elapsed = Date.now() - this.lastFlush;
    const newChars = this.buffer.length - (this.lastFlushedLength ?? 0);

    if (elapsed >= MIN_EDIT_INTERVAL_MS && newChars >= MIN_EDIT_CHARS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), MIN_EDIT_INTERVAL_MS);
    }
  }

  private lastFlushedLength: number = 0;

  private withActivity(content: string): string {
    if (!this.activity) return content;
    const footer = `\n\n> _${this.activity}_`;
    const maxContent = SAFE_MSG_LEN - footer.length;
    if (content.length > maxContent) return content;
    return content + footer;
  }

  private flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.editFailed) return;

    this.lastFlush = Date.now();
    this.lastFlushedLength = this.buffer.length;
    const content = this.buffer;

    if (content.length > SAFE_MSG_LEN) {
      this.splitAndContinue(content);
    } else {
      this.editLatest(this.withActivity(content));
    }
  }

  private async editLatest(content: string) {
    const msg = this.messages[this.messages.length - 1];
    try {
      await this.queue.edit(this.channelId, msg.id, content || "_…_");
    } catch {
      this.editFailed = true;
    }
  }

  private async splitAndContinue(content: string) {
    const chunks = splitMessage(content);
    const currentMsg = this.messages[this.messages.length - 1];

    try {
      await this.queue.edit(this.channelId, currentMsg.id, chunks[0]);
    } catch {
      this.editFailed = true;
      return;
    }

    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      if (isLast) {
        const newMsg = await this.queue.send(this.channelId, chunks[i]);
        this.messages.push(newMsg);
      } else {
        const newMsg = await this.queue.send(this.channelId, chunks[i]);
        this.messages.push(newMsg);
      }
    }
  }

  async finalize(fullOutput?: string) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const content = fullOutput ?? this.buffer;
    if (!content) {
      await this.editLatest("_No output._");
      return;
    }

    this.editFailed = false; // retry on final
    const chunks = splitMessage(content);
    const currentMsg = this.messages[this.messages.length - 1];

    try {
      await this.queue.edit(this.channelId, currentMsg.id, chunks[0]);
    } catch {
      await this.queue.send(this.channelId, chunks[0]);
    }

    for (let i = 1; i < chunks.length; i++) {
      await this.queue.send(this.channelId, chunks[i]);
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", SAFE_MSG_LEN);
    if (splitAt < SAFE_MSG_LEN / 2) splitAt = SAFE_MSG_LEN;

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Check if we're splitting inside an open code block
    const fencePattern = /^(`{3,})\w*/gm;
    let openFence: string | null = null;
    let match: RegExpExecArray | null;
    while ((match = fencePattern.exec(chunk)) !== null) {
      const ticks = match[1];
      if (openFence) {
        // This fence closes the block (matching or longer backtick run)
        if (ticks.length >= openFence.length) openFence = null;
      } else {
        openFence = ticks;
      }
    }

    if (openFence) {
      // Close the dangling code block at end of this chunk
      chunk += "\n" + openFence;
      // Re-open it at the start of the next chunk
      remaining = openFence + "\n" + remaining;
    }

    chunks.push(chunk);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

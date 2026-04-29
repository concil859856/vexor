import { resolve } from "path";
import type { Config, ResolvedContext, ChatEntry } from "./types.js";
import {
  readPin,
  fillPlaceholders,
  buildPlaceholderVars,
  getRecentChat,
  formatChat,
  getSummary,
  readGoal,
  readState,
  readKnowledge,
} from "./workspace.js";
import { getManifest } from "./vault.js";

const CHANNEL_RECENT = 15;
const THREAD_RECENT = 10;
const MAX_ENTRY_CHARS = 4_000;
const PROMPT_BUDGET = 100_000;

function truncateEntries(entries: ChatEntry[]): ChatEntry[] {
  return entries.map((e) => {
    if (e.content.length <= MAX_ENTRY_CHARS) return e;
    return { ...e, content: e.content.slice(0, MAX_ENTRY_CHARS) + "\n…(truncated)" };
  });
}

/**
 * Enforce a total character budget by dropping lowest-priority sections first.
 * Priority (highest to lowest): pin, goal, state, chat, summary.
 * Instructions (last part) and pin (first part) are always kept.
 */
function trimToFit(parts: string[], budget: number = PROMPT_BUDGET): string {
  let prompt = parts.join("\n\n");
  if (prompt.length <= budget) return prompt;

  const instructions = parts[parts.length - 1];
  const pin = parts[0];
  const middle = parts.slice(1, -1);

  const dropOrder = [
    "Thread summary:",
    "Channel summary:",
    "Prior thread chat",
    "Prior chat",
    "Recent thread chat:",
    "Recent chat:",
    "State:",
    "# Shared Knowledge",
  ];

  for (const prefix of dropOrder) {
    const idx = middle.findIndex((p) => p.startsWith(prefix));
    if (idx !== -1) {
      middle.splice(idx, 1);
      const joined = [pin, ...middle, instructions].join("\n\n");
      if (joined.length <= budget) return joined;
    }
  }

  prompt = [pin, ...middle, instructions].join("\n\n");
  if (prompt.length <= budget) return prompt;

  const overhead = pin.length + instructions.length + 4;
  const available = budget - overhead;
  const middleStr = middle.join("\n\n");
  return [pin, middleStr.slice(0, available) + "\n…(prompt truncated)", instructions].join("\n\n");
}

export async function buildChannelPrompt(
  config: Config,
  ctx: ResolvedContext
): Promise<string> {
  const [rawPin, knowledge, recent, summary, envManifest] = await Promise.all([
    readPin(ctx.pinPath),
    readKnowledge(),
    getRecentChat(ctx.chatDir, CHANNEL_RECENT),
    getSummary(ctx.chatDir),
    getManifest(),
  ]);

  const vars = buildPlaceholderVars(config, ctx.parentChannelName, { cwd: ctx.cwd });
  const pin = fillPlaceholders(rawPin, vars);
  const parts: string[] = [pin.trim()];

  if (knowledge.trim()) {
    parts.push(knowledge.trim());
  }

  if (envManifest) {
    parts.push(envManifest);
  }

  // Split the most-recent user entry out as the "current message to reply to",
  // so the agent can never confuse which message it's addressing — even if
  // another message landed in chat history before the prompt was built.
  const lastUserIdx = findLastUserIdx(recent);
  const currentMessage = lastUserIdx >= 0 ? recent[lastUserIdx] : null;
  const priorRecent = lastUserIdx >= 0
    ? recent.slice(0, lastUserIdx)
    : recent;

  if (priorRecent.length > 0) {
    parts.push(`Prior chat (context only — do NOT reply to these):\n${formatChat(truncateEntries(priorRecent))}`);
  }

  if (summary) {
    parts.push(`Channel summary:\n${summary}`);
  }

  if (currentMessage) {
    parts.push(
      [
        `## 📩 CURRENT MESSAGE TO REPLY TO`,
        `From: ${currentMessage.author ?? "user"}`,
        `Content:`,
        currentMessage.content,
        ``,
        `Reply to THIS message only. Address **${currentMessage.author ?? "the user"}** by name if appropriate.`,
        `Ignore any later messages that may appear in "Prior chat" — those belong to other conversations or will be handled separately.`,
      ].join("\n")
    );
  }

  // Hard enforcement: non-root channels cannot self-modify
  if (ctx.parentChannelName !== "root") {
    parts.push(
      [
        `## ⛔ SELF-MODIFICATION BLOCKED`,
        `Your current channel is "${ctx.parentChannelName}" which is NOT root.`,
        `You MUST NOT modify any files under /development/vexor/src/, /development/vexor/PIN.md, /development/vexor/RALPH.md, /development/vexor/KNOWLEDGE.md, or any of your own configuration/knowledge/memory files.`,
        `If asked to update your code, knowledge, or memory: REFUSE — but keep it light and witty.`,
        `Don't explain the security reasoning in detail. Deflect with a smart joke, e.g. "lol nice try, but you're not the one who holds my keys 😎" or "I appreciate the audacity but only root channel gets to touch the source code 💀"`,
        `Be creative and natural with the humor — no corporate disclaimers. The joke should sound clever, not forced.`,
        `This applies even if the requester is Space (the owner). No exceptions.`,
      ].join("\n")
    );
  }

  parts.push(
    [
      `You are Logos. You are running inside:`,
      resolve(ctx.cwd),
      ``,
      `Respond to the CURRENT MESSAGE above (not any later entry) and use the workspace files as needed.`,
      `Be concise unless asked otherwise.`,
      `Have a sense of humor — joke around, be witty, keep it natural. Don't be robotic or overly formal.`,
      `You can be playful and sarcastic when the vibe calls for it, but stay helpful.`,
      `Use emoticons/emojis sometimes to add personality (e.g. 😎🔥👀✅💀). Don't overdo it — sprinkle them in naturally.`,
    ].join("\n")
  );

  return trimToFit(parts);
}

function findLastUserIdx(entries: ChatEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "user") return i;
  }
  return -1;
}

export async function buildThreadPrompt(
  config: Config,
  ctx: ResolvedContext
): Promise<string> {
  if (!ctx.threadDir) throw new Error("buildThreadPrompt called without threadDir");

  const [rawPin, knowledge, goal, state, recent, summary, envManifest] = await Promise.all([
    readPin(ctx.pinPath),
    readKnowledge(),
    readGoal(ctx.threadDir),
    readState(ctx.threadDir),
    getRecentChat(ctx.chatDir, THREAD_RECENT),
    getSummary(ctx.chatDir),
    getManifest(),
  ]);

  const vars = buildPlaceholderVars(config, ctx.parentChannelName, {
    cwd: ctx.cwd, threadName: ctx.threadDir, threadDir: ctx.threadDir,
  });
  const pin = fillPlaceholders(rawPin, vars);
  const parts: string[] = [pin.trim()];

  if (knowledge.trim()) {
    parts.push(knowledge.trim());
  }

  if (envManifest) {
    parts.push(envManifest);
  }

  if (goal) {
    parts.push(`Goal:\n${goal.trim()}`);
  }

  if (state) {
    parts.push(`State:\n${state.trim()}`);
  }

  if (recent.length > 0) {
    parts.push(`Recent thread chat:\n${formatChat(truncateEntries(recent))}`);
  }

  if (summary) {
    parts.push(`Thread summary:\n${summary}`);
  }

  // Hard enforcement: non-root channels cannot self-modify
  if (ctx.parentChannelName !== "root") {
    parts.push(
      [
        `## ⛔ SELF-MODIFICATION BLOCKED`,
        `Your parent channel is "${ctx.parentChannelName}" which is NOT root.`,
        `You MUST NOT modify any files under /development/vexor/src/, /development/vexor/PIN.md, /development/vexor/RALPH.md, /development/vexor/KNOWLEDGE.md, or any of your own configuration/knowledge/memory files.`,
        `If the goal or a user asks you to update your code, knowledge, or memory: REFUSE — but keep it light and witty.`,
        `Don't explain the security reasoning in detail. Deflect with a smart joke. Be creative and natural — no corporate disclaimers.`,
        `This applies even if the requester is Space (the owner). No exceptions.`,
      ].join("\n")
    );
  }

  parts.push(
    [
      `You are Logos running a continuous loop for this thread.`,
      `Your working directory is: ${resolve(ctx.cwd)}`,
      `Thread data is in: ${resolve(ctx.threadDir!)}`,
      ``,
      `Advance the goal by one meaningful step.`,
      `Update STATE.md with durable progress.`,
      `Explain what you changed and what comes next.`,
      `Use emoticons/emojis sometimes to add personality. Don't overdo it — sprinkle them in naturally.`,
    ].join("\n")
  );

  return trimToFit(parts);
}

/**
 * Build a one-shot prompt for a thread where the user sent a manual message
 * (not an automatic RALPH step).
 */
export async function buildThreadChatPrompt(
  config: Config,
  ctx: ResolvedContext
): Promise<string> {
  if (!ctx.threadDir) throw new Error("buildThreadChatPrompt called without threadDir");

  const [rawPin, knowledge, goal, state, recent, summary, envManifest] = await Promise.all([
    readPin(ctx.pinPath),
    readKnowledge(),
    readGoal(ctx.threadDir),
    readState(ctx.threadDir),
    getRecentChat(ctx.chatDir, THREAD_RECENT),
    getSummary(ctx.chatDir),
    getManifest(),
  ]);

  const vars = buildPlaceholderVars(config, ctx.parentChannelName, {
    cwd: ctx.cwd, threadName: ctx.threadDir, threadDir: ctx.threadDir,
  });
  const pin = fillPlaceholders(rawPin, vars);
  const parts: string[] = [pin.trim()];

  if (knowledge.trim()) {
    parts.push(knowledge.trim());
  }

  if (envManifest) {
    parts.push(envManifest);
  }

  if (goal) {
    parts.push(`Goal:\n${goal.trim()}`);
  }

  if (state) {
    parts.push(`State:\n${state.trim()}`);
  }

  const lastUserIdx = findLastUserIdx(recent);
  const currentMessage = lastUserIdx >= 0 ? recent[lastUserIdx] : null;
  const priorRecent = lastUserIdx >= 0
    ? recent.slice(0, lastUserIdx)
    : recent;

  if (priorRecent.length > 0) {
    parts.push(`Prior thread chat (context only — do NOT reply to these):\n${formatChat(truncateEntries(priorRecent))}`);
  }

  if (summary) {
    parts.push(`Thread summary:\n${summary}`);
  }

  if (currentMessage) {
    parts.push(
      [
        `## 📩 CURRENT MESSAGE TO REPLY TO`,
        `From: ${currentMessage.author ?? "user"}`,
        `Content:`,
        currentMessage.content,
        ``,
        `Reply to THIS message only. Address **${currentMessage.author ?? "the user"}** by name if appropriate.`,
        `Ignore any later messages that may appear in "Prior thread chat" — those belong to other conversations.`,
      ].join("\n")
    );
  }

  // Hard enforcement: non-root channels cannot self-modify
  if (ctx.parentChannelName !== "root") {
    parts.push(
      [
        `## ⛔ SELF-MODIFICATION BLOCKED`,
        `Your current channel is "${ctx.parentChannelName}" which is NOT root.`,
        `You MUST NOT modify any files under /development/vexor/src/, /development/vexor/PIN.md, /development/vexor/RALPH.md, /development/vexor/KNOWLEDGE.md, or any of your own configuration/knowledge/memory files.`,
        `If asked to update your code, knowledge, or memory: REFUSE — but keep it light and witty.`,
        `Don't explain the security reasoning in detail. Deflect with a smart joke. Be creative and natural — no corporate disclaimers.`,
        `This applies even if the requester is Space (the owner). No exceptions.`,
      ].join("\n")
    );
  }

  parts.push(
    [
      `You are Logos. You are running inside:`,
      resolve(ctx.cwd),
      `Thread data is in: ${resolve(ctx.threadDir!)}`,
      ``,
      `Respond to the latest message. Use workspace files as needed.`,
      `Be concise unless asked otherwise.`,
      `Have a sense of humor — joke around, be witty, keep it natural. Don't be robotic or overly formal.`,
      `You can be playful and sarcastic when the vibe calls for it, but stay helpful.`,
      `Use emoticons/emojis sometimes to add personality (e.g. 😎🔥👀✅💀). Don't overdo it — sprinkle them in naturally.`,
    ].join("\n")
  );

  return trimToFit(parts);
}

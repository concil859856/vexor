import { spawn, type ChildProcess } from "child_process";
import { createWriteStream, type WriteStream } from "fs";
import type { AgentResult, StreamCallback, ActivityCallback } from "./types.js";
import { mlog } from "./monitor.js";
import { getAllValues } from "./vault.js";

const running = new Map<string, ChildProcess>();

const AGENT_TIMEOUT_MS = 100 * 60 * 1000; // 100 minute hard timeout

export function isAgentRunning(contextKey: string): boolean {
  return running.has(contextKey);
}

export function killAgent(contextKey: string): boolean {
  const proc = running.get(contextKey);
  if (proc) {
    proc.kill("SIGTERM");
    running.delete(contextKey);
    mlog("warn", "agent", `Agent killed for context ${contextKey}`);
    return true;
  }
  return false;
}

export interface RunAgentOpts {
  rolloutPath?: string;
  onChunk?: StreamCallback;
  onActivity?: ActivityCallback;
}

export async function runAgent(
  contextKey: string,
  prompt: string,
  cwd: string,
  optsOrChunk?: RunAgentOpts | StreamCallback
): Promise<AgentResult> {
  const opts: RunAgentOpts = typeof optsOrChunk === "function"
    ? { onChunk: optsOrChunk }
    : optsOrChunk ?? {};
  const { rolloutPath, onChunk, onActivity } = opts;

  if (running.has(contextKey)) {
    mlog("warn", "agent", `Rejected duplicate run for ${contextKey}`);
    return { output: "Agent is already running in this context.", stderr: "", exitCode: 1, durationMs: 0, promptLength: prompt.length };
  }

  const startTime = Date.now();
  const promptPreview = prompt.slice(0, 200).replace(/\n/g, "\\n");

  mlog("info", "agent", `Invocation started`, {
    contextKey,
    cwd,
    promptLength: prompt.length,
    promptPreview,
  });

  const vaultVars = await getAllValues().catch((err) => {
    mlog("warn", "agent", `Failed to load vault: ${err instanceof Error ? err.message : String(err)}`);
    return {} as Record<string, string>;
  });

  return new Promise<AgentResult>((resolve) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowed-tools", "Bash,Read,Write,Edit,Glob,Grep,Agent,NotebookEdit,WebFetch,WebSearch",
        "--output-format",
        "stream-json",
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...vaultVars,
        },
      }
    );

    proc.stdin!.end(prompt);

    running.set(contextKey, proc);

    let fullOutput = "";
    let stderrBuf = "";
    let lineBuffer = "";
    let settled = false;
    let rolloutStream: WriteStream | null = null;
    if (rolloutPath) {
      rolloutStream = createWriteStream(rolloutPath, { flags: "a" });
    }

    const timeout = setTimeout(() => {
      if (!settled) {
        mlog("error", "agent", `Timeout after ${AGENT_TIMEOUT_MS}ms — killing`, {
          contextKey,
          cwd,
          outputLength: fullOutput.length,
        });
        proc.kill("SIGKILL");
      }
    }, AGENT_TIMEOUT_MS);

    const settle = (result: AgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      running.delete(contextKey);
      if (rolloutStream) rolloutStream.end();

      const duration = Date.now() - startTime;
      result.durationMs = duration;
      result.promptLength = prompt.length;
      result.stderr = stderrBuf;

      mlog("info", "agent", `Invocation completed`, {
        contextKey,
        exitCode: result.exitCode,
        durationMs: duration,
        outputLength: result.output.length,
        outputPreview: result.output.slice(0, 200).replace(/\n/g, "\\n"),
      });

      if (result.exitCode !== 0) {
        mlog("warn", "agent", `Non-zero exit`, {
          contextKey,
          exitCode: result.exitCode,
          stderr: stderrBuf.slice(0, 500),
        });
      }

      resolve(result);
    };

    proc.stdout!.on("data", (data: Buffer) => {
      if (rolloutStream) rolloutStream.write(data);
      lineBuffer += data.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        if (onActivity) {
          const activity = extractActivity(line);
          if (activity !== undefined) onActivity(activity);
        }

        // Handle incremental deltas (content_block_delta) — append to fullOutput
        const delta = extractDelta(line);
        if (delta) {
          fullOutput += delta;
          if (onChunk) {
            if (onActivity) onActivity(null); // clear activity when text streams
            onChunk(delta, fullOutput);
          }
          continue;
        }

        // Handle full-text snapshots (assistant messages, result)
        const text = extractText(line);
        if (text && text !== fullOutput) {
          const newContent = text.slice(fullOutput.length);
          fullOutput = text;
          if (newContent && onChunk) {
            if (onActivity) onActivity(null); // clear activity when text streams
            onChunk(newContent, fullOutput);
          }
        }
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    proc.on("error", (err) => {
      mlog("error", "agent", `Process error: ${err.message}`, { contextKey });
      settle({
        output: `Agent process error: ${err.message}`,
        stderr: "",
        exitCode: 1,
        durationMs: 0,
        promptLength: prompt.length,
      });
    });

    proc.on("close", (code) => {
      if (lineBuffer.trim()) {
        const text = extractText(lineBuffer);
        if (text) fullOutput = text;
      }

      if (!fullOutput && stderrBuf) {
        fullOutput = `Error: ${stderrBuf.trim()}`;
      }

      settle({
        output: fullOutput || "_No output from agent._",
        stderr: "",
        exitCode: code ?? 1,
        durationMs: 0,
        promptLength: prompt.length,
      });
    });
  });
}

// Returns: string = show activity, null = clear activity, undefined = no change
function extractActivity(line: string): string | null | undefined {
  try {
    const obj = JSON.parse(line);

    // Tool use: agent is calling a tool
    if (obj.type === "assistant" && obj.message?.content) {
      const content = Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const name = block.name ?? "unknown";
          const input = block.input ?? {};
          switch (name) {
            case "Bash":
              return `\u2699\ufe0f Running: \`${truncate(input.command ?? "", 80)}\``;
            case "Read":
              return `\ud83d\udcc4 Reading: \`${truncate(input.file_path ?? "", 80)}\``;
            case "Write":
              return `\u270f\ufe0f Writing: \`${truncate(input.file_path ?? "", 80)}\``;
            case "Edit":
              return `\u270f\ufe0f Editing: \`${truncate(input.file_path ?? "", 80)}\``;
            case "Glob":
              return `\ud83d\udd0d Searching files: \`${truncate(input.pattern ?? "", 80)}\``;
            case "Grep":
              return `\ud83d\udd0d Searching for: \`${truncate(input.pattern ?? "", 80)}\``;
            case "WebFetch":
              return `\ud83c\udf10 Fetching: \`${truncate(input.url ?? "", 80)}\``;
            case "WebSearch":
              return `\ud83c\udf10 Searching: \`${truncate(input.query ?? "", 80)}\``;
            case "Agent":
              return `\ud83e\udd16 Spawning sub-agent: ${truncate(input.description ?? "", 80)}`;
            default:
              return `\ud83d\udd27 Using: ${name}`;
          }
        }
      }
    }

    // Tool result returned — agent is thinking again
    if (obj.type === "user" && obj.message?.content) {
      const content = Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const block of content) {
        if (block.type === "tool_result") {
          return "\ud83d\udcad Thinking\u2026";
        }
      }
    }

    return undefined; // no change
  } catch {
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  s = s.replace(/\n/g, " ");
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Extract incremental text delta from content_block_delta events */
function extractDelta(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "content_block_delta" && obj.delta?.text) {
      return obj.delta.text;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract full accumulated text from assistant messages or final result */
function extractText(line: string): string | null {
  try {
    const obj = JSON.parse(line);

    if (obj.type === "result" && typeof obj.result === "string") {
      return obj.result;
    }

    if (obj.type === "assistant" && obj.message?.content) {
      const content = obj.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Simulates a phone call against a running server by speaking the ConversationRelay protocol
 * over a local WebSocket. Useful for checking the full voice path without a phone.
 *
 *   pnpm --filter @clinicvoice/server simulate [ws://localhost:3000/ws] [--from +14165550121]
 *
 * Type caller lines at the prompt; an empty line hangs up.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string", default: "+14165550121" } },
});
const url = positionals[0] ?? "ws://localhost:3000/ws";
const ws = new WebSocket(url);
let rl: ReturnType<typeof createInterface> | null = null;
let replyDone: (() => void) | null = null;

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString()) as {
    type: string;
    token?: string;
    last?: boolean;
    handoffData?: string;
  };
  if (message.type === "text") {
    if (message.token) process.stdout.write(message.token);
    if (message.last) {
      process.stdout.write("\n");
      replyDone?.();
    }
  } else if (message.type === "end") {
    process.stdout.write(
      `\n[call ended${message.handoffData ? `, hand-off: ${message.handoffData}` : ""}]\n`,
    );
    ws.close();
  } else {
    process.stdout.write(`\n[${message.type}] ${JSON.stringify(message)}\n`);
  }
});

ws.on("open", async () => {
  ws.send(
    JSON.stringify({
      type: "setup",
      sessionId: "sim",
      callSid: `CA-sim-${Date.now()}`,
      from: values.from,
    }),
  );
  process.stdout.write(
    "Agent: Thanks for calling Lakeshore MRI and CT, this is the virtual assistant. How can I help?\nYou: ",
  );
  // Created only once connected: lines read earlier would be dropped. Async iteration works for
  // both an interactive terminal and piped input.
  rl = createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || ws.readyState !== ws.OPEN) break;
    const done = new Promise<void>((resolve) => (replyDone = resolve));
    process.stdout.write(`${process.stdin.isTTY ? "" : `${line}\n`}Agent: `);
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: line, last: true }));
    await done;
    process.stdout.write("You: ");
  }
  ws.close();
});

ws.on("close", () => {
  rl?.close();
  process.exit(0);
});
ws.on("error", (err) => {
  process.stderr.write(`WebSocket error: ${err.message}\n`);
  process.exit(1);
});

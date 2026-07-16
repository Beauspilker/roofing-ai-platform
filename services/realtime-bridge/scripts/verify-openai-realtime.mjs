import WebSocket from "ws";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";

if (!apiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
const socket = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
  },
});

let settled = false;

function finish(code, message) {
  if (settled) {
    return;
  }

  settled = true;
  console.log(message);
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "verification complete");
  }
  process.exit(code);
}

socket.on("open", () => {
  console.log("openai_connected");
  socket.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "whisper-1" },
            turn_detection: {
              type: "server_vad",
              create_response: false,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: process.env.OPENAI_REALTIME_VOICE ?? "echo",
          },
        },
      },
    }),
  );
});

socket.on("message", (data) => {
  const event = JSON.parse(data.toString());
  console.log("event", event.type);

  if (event.type === "session.updated") {
    finish(0, "openai_session_ready");
    return;
  }

  if (event.type === "error") {
    finish(1, `openai_error:${JSON.stringify(event.error ?? event)}`);
  }
});

socket.on("close", (code, reasonBuffer) => {
  const reason = reasonBuffer.toString();
  if (!settled) {
    finish(code === 1000 ? 0 : 1, `openai_disconnected code=${code} reason=${reason}`);
  }
});

socket.on("error", (error) => {
  finish(1, `openai_socket_error:${error.message}`);
});

setTimeout(() => finish(1, "openai_verification_timeout"), 15000);

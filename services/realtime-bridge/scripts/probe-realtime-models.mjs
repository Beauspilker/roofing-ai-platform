import WebSocket from "ws";

const models = [
  "gpt-4o-realtime-preview",
  "gpt-4o-realtime-preview-2024-10-01",
  "gpt-4o-realtime-preview-2024-12-17",
  "gpt-4o-realtime-preview-2025-06-03",
  "gpt-4o-mini-realtime-preview",
  "gpt-4o-mini-realtime-preview-2024-12-17",
  "gpt-realtime",
  "gpt-realtime-1.5",
  "gpt-realtime-2",
  "gpt-realtime-mini",
  "gpt-realtime-mini-2025-10-06",
];

async function testModel(model) {
  return new Promise((resolve) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        socket.close();
      } catch {
        // ignore close errors during probe teardown
      }

      resolve(result);
    };

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            audio: {
              input: { format: { type: "audio/pcmu" } },
              output: { format: { type: "audio/pcmu" }, voice: "echo" },
            },
          },
        }),
      );
    });

    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === "session.updated") {
        finish({ model, ok: true });
      }

      if (event.type === "error") {
        finish({ model, ok: false, error: event.error });
      }
    });

    socket.on("close", (code, reason) => {
      if (!settled) {
        finish({ model, ok: false, error: { code, reason: reason.toString() } });
      }
    });

    socket.on("error", (error) => {
      finish({ model, ok: false, error: { message: error.message } });
    });

    setTimeout(() => finish({ model, ok: false, error: { message: "timeout" } }), 10000);
  });
}

for (const model of models) {
  const result = await testModel(model);
  console.log(JSON.stringify(result));

  if (result.ok) {
    process.exit(0);
  }
}

process.exit(1);

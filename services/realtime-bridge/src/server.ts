import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { assertBridgeConfig, getConfig } from "./config.js";
import { CallBridge } from "./bridge/call-bridge.js";
import { logError, logInfo } from "./logger.js";

const config = getConfig();

try {
  assertBridgeConfig(config);
} catch (error) {
  logError("bridge_config_invalid", {}, error);
  process.exit(1);
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (requestUrl.pathname !== config.mediaPath) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});

wss.on("connection", (twilioSocket) => {
  const bridge = new CallBridge({ twilioSocket, config });
  bridge.start();
});

server.listen(config.port, () => {
  logInfo("realtime_bridge_listening", {
    port: config.port,
    mediaPath: config.mediaPath,
    bargeInEnabled: config.bargeInEnabled,
  });
});

process.on("SIGINT", () => {
  logInfo("realtime_bridge_shutdown");
  wss.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  logInfo("realtime_bridge_shutdown");
  wss.close();
  server.close(() => process.exit(0));
});

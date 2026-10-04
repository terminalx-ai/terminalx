// Run alongside the native fixture. Commands/metrics are synthetic and local only.
import http from "node:http";
let command = {};
let metrics = {};
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/command") command = body;
    else if (req.url === "/metrics") metrics = { ...body, measuredAt: Date.now() };
    res.end("{}");
  } else if (req.url === "/command") {
    res.end(JSON.stringify(command)); command = {};
  } else res.end(JSON.stringify(metrics));
}).listen(18746, "127.0.0.1", () => console.log("Synthetic viewport driver: http://127.0.0.1:18746"));

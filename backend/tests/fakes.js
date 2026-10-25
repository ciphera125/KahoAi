// Stand-ins for Plivo's API and our voice server's /answer, on fixed local ports.
import http from "node:http";

function server(port, handle) {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handle(req, res, body));
  });
  return new Promise((resolve) => s.listen(port, "127.0.0.1", () => resolve(s)));
}

export async function startFakes() {
  const plivo = { requests: [], reply: { status: 201, body: { request_uuid: "req-0001-abcd", message: "call fired" } }, cdrs: [] };
  const voice = { requests: [], reply: { status: 200, body: '<Response><Stream bidirectional="true">wss://x/ws</Stream></Response>' } };
  const p = await server(18765, (req, res, body) => {
    plivo.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (req.method === "GET" && /\/Call\/$/.test(req.url.split("?")[0])) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ objects: plivo.cdrs, meta: { next: null } }));
    }
    if (plivo.reply.hang) return; // never answers
    const reply = typeof plivo.reply === "function" ? plivo.reply(JSON.parse(body || "null")) : plivo.reply;
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  const v = await server(18766, (req, res) => {
    voice.requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(voice.reply.status, { "Content-Type": "application/xml" });
    res.end(voice.reply.body);
  });
  return { plivo, voice, close: () => Promise.all([new Promise((r) => p.close(r)), new Promise((r) => v.close(r))]) };
}

// Local fake of the few Cloudflare API routes the Vault calls (dev only; Node script, never deployed).
import http from "node:http";
const ok = (r) => JSON.stringify({ success: true, errors: [], messages: [], result: r });
const bad = (c, m) => JSON.stringify({ success: false, errors: [{ code: c, message: m }], messages: [], result: null });
const workers = new Set();
http.createServer((req, res) => {
  const path = req.url.replace(/^\/client\/v4/, "");
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    console.log(req.method, path, req.headers.authorization ? "auth:yes" : "auth:no");
    const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(b); };
    let m;
    if (req.method === "GET" && /\/accounts\/[0-9a-f]{32}\/tokens\/verify$/.test(path)) return send(200, ok({ id: "t", status: "active" }));
    if ((m = /\/workers\/workers\/([^/]+)$/.exec(path)) && req.method === "GET") return workers.has(m[1]) ? send(200, ok({ id: "w", name: m[1] })) : send(404, bad(10007, "not found"));
    if (req.method === "POST" && /\/workers\/workers$/.test(path)) { const n = JSON.parse(body).name; workers.add(n); return send(200, ok({ id: "w", name: n })); }
    if (req.method === "GET" && /\/workers\/subdomain$/.test(path)) return send(200, ok({ subdomain: "itest" }));
    send(404, bad(7003, "no route " + path));
  });
}).listen(8799, "127.0.0.1", () => console.log("fake cf on 8799"));

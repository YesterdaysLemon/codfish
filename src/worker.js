// Codfish v0: serves the static demo board.
import HTML from "../public/index.html";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" && url.pathname !== "/index.html") return new Response("Not found", { status: 404 });
    return new Response(HTML, { headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    } });
  },
};

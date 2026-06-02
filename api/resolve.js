// Vercel serverless function: /api/resolve?url=<google maps link>
// Follows the link (incl. short maps.app.goo.gl links) server-side and pulls
// out the latitude/longitude. Restricted to Google Maps hosts (no open proxy).

const ALLOWED = [
  /(^|\.)google\.com$/i,
  /(^|\.)google\.[a-z.]+$/i,   // google.com.my etc.
  /(^|\.)goo\.gl$/i,
  /(^|\.)app\.goo\.gl$/i,
];

function extractCoords(s) {
  if (!s) return null;
  const m =
    s.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/) ||
    s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/) ||
    s.match(/[?&](?:q|query|ll|center|destination)=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export default async function handler(req, res) {
  const url = (req.query.url || "").trim();
  if (!url) { res.status(400).json({ error: "Missing url." }); return; }

  let host;
  try { host = new URL(url).hostname; } catch { res.status(400).json({ error: "That doesn't look like a link." }); return; }
  if (!ALLOWED.some((rx) => rx.test(host))) {
    res.status(400).json({ error: "Only Google Maps links are supported." });
    return;
  }

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MyFoodFinder/1.0)", "Accept-Language": "en" },
      redirect: "follow",
    });
    // Try the final (redirected) URL first, then the page body.
    let coords = extractCoords(r.url || "");
    if (!coords) {
      let body = "";
      try { body = await r.text(); } catch {}
      coords = extractCoords(body);
    }
    if (coords) {
      res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
      res.status(200).json(coords);
    } else {
      res.status(404).json({ error: "Couldn't find a location in that link." });
    }
  } catch (err) {
    res.status(500).json({ error: "Couldn't open that link." });
  }
}

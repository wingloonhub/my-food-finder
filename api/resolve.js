// Vercel serverless function: /api/resolve?url=<google maps link>
// Follows a Google Maps link (incl. short maps.app.goo.gl links) server-side,
// pulls the place NAME and COORDINATES out of the resolved URL, then reverse-
// geocodes those coordinates against free OpenStreetMap data to fill in the
// address (and cuisine/hours/phone when OSM has them).
// Restricted to Google Maps hosts — not an open proxy. No paid API, no key.

const ALLOWED = [
  /(^|\.)google\.com$/i,
  /(^|\.)google\.[a-z.]+$/i,
  /(^|\.)share\.google$/i,
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

function extractName(url, html) {
  // Preferred: the /maps/place/<Name>/ path segment.
  let m = (url || "").match(/\/maps\/place\/([^/@?]+)/);
  if (m) {
    try { return decodeURIComponent(m[1].replace(/\+/g, " ")).trim(); }
    catch { return m[1].replace(/\+/g, " ").trim(); }
  }
  // Fallback: the page <title> ("Name - Google Maps").
  m = (html || "").match(/<title>([^<]+)<\/title>/i);
  if (m) {
    const t = m[1].replace(/\s*-\s*Google Maps.*/i, "").trim();
    if (t && !/google maps/i.test(t) && !/^https?:/i.test(t)) return t;
  }
  return "";
}

async function reverseGeocode(lat, lng) {
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&extratags=1&addressdetails=1&zoom=18`;
    const r = await fetch(u, { headers: { "User-Agent": "MyFoodFinder/1.0", "Accept-Language": "en" } });
    if (!r.ok) return {};
    const p = await r.json();
    const e = p.extratags || {}, a = p.address || {};
    const parts = [
      a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road,
      a.suburb || a.neighbourhood || a.quarter,
      a.city || a.town || a.village,
      a.state, a.postcode,
    ].filter(Boolean);
    return {
      address: parts.join(", "),
      cuisine: (e.cuisine || "").replace(/[_;]/g, " ").replace(/\s+/g, " ").trim(),
      openingHours: e.opening_hours || "",
      phone: e.phone || e["contact:phone"] || a.phone || "",
      district: a.city || a.town || a.suburb || a.county || a.state || "",
    };
  } catch { return {}; }
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
    const finalUrl = r.url || "";
    let body = "";
    try { body = await r.text(); } catch {}

    const coords = extractCoords(finalUrl) || extractCoords(body);
    const name = extractName(finalUrl, body);

    if (!coords && !name) {
      res.status(404).json({ error: "Couldn't read that link. Try opening it in Google Maps and sharing the link again." });
      return;
    }

    const enriched = coords ? await reverseGeocode(coords.lat, coords.lng) : {};
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    res.status(200).json({
      name,
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      ...enriched,
    });
  } catch (err) {
    res.status(500).json({ error: "Couldn't open that link." });
  }
}

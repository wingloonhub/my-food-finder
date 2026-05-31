// Vercel serverless function: /api/search?name=...&cc=my
// Proxies to OpenStreetMap Nominatim so the browser never hits it directly
// (keeps a proper identifying User-Agent, per Nominatim usage policy, and
// avoids CORS/rate issues). No API key, no billing required.

const COUNTRY_TO_CC = {
  malaysia: "my", singapore: "sg", thailand: "th", indonesia: "id",
  vietnam: "vn", philippines: "ph", japan: "jp", "south korea": "kr",
  "hong kong": "hk", taiwan: "tw", china: "cn", india: "in",
  australia: "au", "united kingdom": "gb", uk: "gb", "united states": "us",
  usa: "us", france: "fr", italy: "it", spain: "es", germany: "de",
};

export default async function handler(req, res) {
  const name = (req.query.name || "").trim();
  let cc = (req.query.cc || "").trim().toLowerCase();
  const country = (req.query.country || "").trim().toLowerCase();

  if (!name) {
    res.status(400).json({ error: "Missing 'name'." });
    return;
  }
  if (!cc && country) cc = COUNTRY_TO_CC[country] || "";

  const params = new URLSearchParams({
    q: name,
    format: "jsonv2",
    extratags: "1",
    addressdetails: "1",
    limit: "8",
  });
  if (cc) params.set("countrycodes", cc);

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        // Nominatim's usage policy asks for an identifying User-Agent. Kept
        // generic (no personal info) for a public repo. Optionally add your
        // deployed URL as a contact, e.g. "MyFoodFinder/1.0 (+https://your-app.vercel.app)".
        "User-Agent": "MyFoodFinder/1.0",
        "Accept-Language": "en",
      },
    });
    if (!r.ok) {
      res.status(502).json({ error: `Lookup service returned ${r.status}` });
      return;
    }
    const data = await r.json();

    const results = (Array.isArray(data) ? data : []).map((p) => {
      const e = p.extratags || {};
      const a = p.address || {};
      const addressParts = [
        p.name || a.amenity,
        a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road,
        a.suburb || a.neighbourhood || a.quarter,
        a.city || a.town || a.village,
        a.state, a.postcode,
      ].filter(Boolean);
      // Auto-derive a state/district from the address — prefer the
      // city/town level (e.g. "Petaling Jaya"), fall back to state/county.
      const district = a.city || a.town || a.municipality || a.suburb ||
        a.county || a.state_district || a.state || "";
      return {
        name: p.name || (p.display_name || "").split(",")[0],
        displayName: p.display_name || "",
        district,
        address: addressParts.join(", "),
        cuisine: (e.cuisine || "").replace(/[_;]/g, " ").replace(/\s+/g, " ").trim(),
        openingHours: e.opening_hours || "",
        phone: e.phone || e["contact:phone"] || a.phone || "",
        website: e.website || e["contact:website"] || "",
        lat: p.lat,
        lng: p.lon,
        category: p.type || p.category || "",
      };
    });

    // Cache at the edge for a day to be gentle on Nominatim.
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: "Lookup failed.", detail: String(err) });
  }
}

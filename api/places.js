// Vercel serverless function: POST /api/places
// Google-backed restaurant lookup (name/address/opening hours/location).
//
// Confirms the caller is a logged-in user of THIS Firebase project by verifying
// their Firebase ID token against Google's public certificates — NO downloadable
// service-account key required (works under org policies that block key creation).
//
// Bill protection is handled at the Google level (a daily quota cap on the Places
// API) + your budget alert. Per-user counts are tracked client-side for the admin
// dashboard.
//
// Needs ONE Vercel environment variable:
//   GOOGLE_PLACES_KEY — your Google Maps Platform API key (Places + Distance Matrix)

import jwt from "jsonwebtoken";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "my-food-finder-cf1c3";
const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certsCache = null, certsExpiry = 0;
async function getCerts() {
  if (certsCache && Date.now() < certsExpiry) return certsCache;
  const r = await fetch(CERTS_URL);
  certsCache = await r.json();
  certsExpiry = Date.now() + 60 * 60 * 1000; // refresh hourly
  return certsCache;
}

async function verifyFirebaseToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw new Error("malformed token");
  const certs = await getCerts();
  const cert = certs[decoded.header.kid];
  if (!cert) throw new Error("no matching key");
  return jwt.verify(token, cert, {
    algorithms: ["RS256"],
    audience: PROJECT_ID,
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
  });
}

const DAY_CODE = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]; // Google: 0 = Sunday
const DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Convert Google regularOpeningHours.periods into our "Mo 08:00-22:00; ..." string.
function hoursFromGoogle(oh) {
  if (!oh || !Array.isArray(oh.periods)) return "";
  const byDay = {};
  for (const p of oh.periods) {
    if (!p.open) continue;
    const code = DAY_CODE[p.open.day];
    const from = `${String(p.open.hour ?? 0).padStart(2, "0")}:${String(p.open.minute ?? 0).padStart(2, "0")}`;
    const to = p.close
      ? `${String(p.close.hour ?? 0).padStart(2, "0")}:${String(p.close.minute ?? 0).padStart(2, "0")}`
      : "23:59";
    (byDay[code] = byDay[code] || []).push(`${from}-${to}`);
  }
  return DAY_ORDER.filter((c) => byDay[c]).map((c) => `${c} ${byDay[c].join(",")}`).join("; ");
}

// Pick a sensible "state / district" from Google's address components
// (prefer city/town level, then sub-area, then state).
function districtFromComponents(comps) {
  if (!Array.isArray(comps)) return "";
  const pick = (type) => {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(type));
    return c ? (c.longText || c.shortText || "") : "";
  };
  return pick("locality") || pick("administrative_area_level_2") ||
    pick("sublocality") || pick("postal_town") || pick("administrative_area_level_1") || "";
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const { idToken, name, lat, lng, country } = await readBody(req);
  if (!idToken || !name) { res.status(400).json({ error: "Missing token or name." }); return; }

  try {
    await verifyFirebaseToken(idToken);
  } catch {
    res.status(401).json({ error: "auth_failed" }); return;
  }

  const body = { textQuery: country ? `${name}, ${country}` : name, languageCode: "en" };
  if (lat && lng) body.locationBias = { circle: { center: { latitude: +lat, longitude: +lng }, radius: 5000 } };

  let gd;
  try {
    const gr = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.regularOpeningHours,places.rating,places.nationalPhoneNumber",
      },
      body: JSON.stringify(body),
    });
    gd = await gr.json();
    if (!gr.ok) { res.status(502).json({ error: "google_error", detail: gd.error && gd.error.message }); return; }
  } catch {
    res.status(502).json({ error: "google_unreachable" }); return;
  }

  const results = (gd.places || []).slice(0, 6).map((p) => ({
    name: (p.displayName && p.displayName.text) || name,
    address: p.formattedAddress || "",
    district: districtFromComponents(p.addressComponents),
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    openingHours: hoursFromGoogle(p.regularOpeningHours),
    rating: p.rating ?? null,
    phone: p.nationalPhoneNumber || "",
  }));

  res.status(200).json({ results });
}

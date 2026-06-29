// Vercel serverless function: POST /api/places
// Google-backed restaurant lookup with per-user enforcement.
//   1. Verifies the caller's Firebase ID token (who they are).
//   2. Checks their monthly usage vs. limit + that they aren't disabled.
//   3. If OK -> calls Google Places (New) for name/address/hours/location,
//      and increments their usage. If over limit -> refuses (protects your bill).
//
// Needs two Vercel environment variables:
//   GOOGLE_PLACES_KEY        — your Google Maps Platform API key
//   FIREBASE_SERVICE_ACCOUNT — the full contents of the service-account .json

import admin from "firebase-admin";

function getAdmin() {
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin;
}

const ymPeriod = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
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
      : "23:59"; // open 24h / no close
    (byDay[code] = byDay[code] || []).push(`${from}-${to}`);
  }
  return DAY_ORDER.filter((c) => byDay[c]).map((c) => `${c} ${byDay[c].join(",")}`).join("; ");
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

  let decoded;
  try {
    decoded = await getAdmin().auth().verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: "auth_failed" }); return;
  }

  const db = getAdmin().firestore();
  const ref = db.doc(`users/${decoded.uid}`);
  let data = {};
  try { const s = await ref.get(); data = s.exists ? s.data() : {}; } catch {}

  if (data.disabled) { res.status(403).json({ error: "disabled" }); return; }
  const period = ymPeriod();
  const used = data.apiPeriod === period ? (data.apiUsed || 0) : 0;
  const limit = data.apiLimit ?? 200;
  if (used >= limit) { res.status(429).json({ error: "over_limit", used, limit }); return; }

  // --- Google Places (New) text search ---
  const body = { textQuery: country ? `${name}, ${country}` : name, languageCode: "en" };
  if (lat && lng) body.locationBias = { circle: { center: { latitude: +lat, longitude: +lng }, radius: 5000 } };
  let gd;
  try {
    const gr = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.rating,places.nationalPhoneNumber",
      },
      body: JSON.stringify(body),
    });
    gd = await gr.json();
    if (!gr.ok) { res.status(502).json({ error: "google_error", detail: gd.error && gd.error.message }); return; }
  } catch (e) {
    res.status(502).json({ error: "google_unreachable" }); return;
  }

  const results = (gd.places || []).slice(0, 6).map((p) => ({
    name: (p.displayName && p.displayName.text) || name,
    address: p.formattedAddress || "",
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    openingHours: hoursFromGoogle(p.regularOpeningHours),
    rating: p.rating ?? null,
    phone: p.nationalPhoneNumber || "",
  }));

  // Count this lookup against the user's monthly limit.
  try {
    await ref.set({
      apiPeriod: period,
      apiUsed: data.apiPeriod === period ? used + 1 : 1,
      email: decoded.email || data.email || "",
    }, { merge: true });
  } catch {}

  res.status(200).json({ results });
}

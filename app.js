import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, addDoc,
  deleteDoc, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Config / setup
// ---------------------------------------------------------------------------
const CONFIGURED = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("PASTE_");
// Demo mode (sample data, no login, browser-only) is the fallback used before
// Firebase is configured. Once a real config is present, the account-backed app
// runs everywhere — including locally. You can still force the sample version
// for a demo by adding ?demo=1 to the URL.
const FORCE_DEMO = location.search.includes("demo=1");
const DEMO = FORCE_DEMO || !CONFIGURED;

let auth, db;
if (CONFIGURED && !DEMO) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

// Country -> timezone (for Open/Closed + crowd, evaluated in the restaurant's local time)
const COUNTRY_TZ = {
  Malaysia: "Asia/Kuala_Lumpur", Singapore: "Asia/Singapore", Thailand: "Asia/Bangkok",
  Indonesia: "Asia/Jakarta", Vietnam: "Asia/Ho_Chi_Minh", Philippines: "Asia/Manila",
  Japan: "Asia/Tokyo", "South Korea": "Asia/Seoul", "Hong Kong": "Asia/Hong_Kong",
  Taiwan: "Asia/Taipei", China: "Asia/Shanghai", India: "Asia/Kolkata",
  Australia: "Australia/Sydney", "United Kingdom": "Europe/London",
  "United States": "America/New_York", France: "Europe/Paris",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  uid: null,
  countries: ["Malaysia"],
  activeCountry: "Malaysia",
  activeDistrict: "",   // "" = all areas in the active country
  cuisine: "",
  cuisines: [],         // managed cuisine list for the dropdown (Settings)
  openOnly: false,      // show only restaurants open right now
  editingId: null,      // id of the restaurant being edited (null = adding new)
  restaurants: [],      // all restaurants for the user
  userPos: null,        // {lat, lng}
  locDenied: false,     // true once the user blocks the location prompt
  unsub: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Capitalise the first letter of each word (leaves the rest as typed, so
// "mcdonald's" -> "Mcdonald's", "village park" -> "Village Park").
const titleCase = (s) => String(s ?? "").replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));

// ---------------------------------------------------------------------------
// STORAGE ADAPTER — Firebase in production, localStorage in demo mode.
// Both expose the same interface so the rest of the app doesn't care which.
// ---------------------------------------------------------------------------
const LS_COUNTRIES = "rt_demo_countries";
const LS_CUISINES = "rt_demo_cuisines";
const LS_RESTAURANTS = "rt_demo_restaurants";

const DEFAULT_CUISINES = [
  "Malaysian", "Malay", "Chinese", "Indian", "Mamak / Indian", "Japanese",
  "Korean", "Thai", "Western", "Cafe", "Seafood", "Vegetarian", "Fast Food", "Dessert",
];

function firebaseStore() {
  return {
    demo: false,
    initAuth(onChange) { onAuthStateChanged(auth, onChange); },
    signup(email, pw) { return createUserWithEmailAndPassword(auth, email, pw); },
    login(email, pw) { return signInWithEmailAndPassword(auth, email, pw); },
    logout() { return signOut(auth); },
    async getCountries() {
      const s = await getDoc(doc(db, "users", state.uid));
      return s.exists() && Array.isArray(s.data().countries) ? s.data().countries : null;
    },
    async setCountries(arr) {
      await setDoc(doc(db, "users", state.uid), { countries: arr }, { merge: true });
    },
    async getCuisines() {
      const s = await getDoc(doc(db, "users", state.uid));
      return s.exists() && Array.isArray(s.data().cuisines) ? s.data().cuisines : null;
    },
    async setCuisines(arr) {
      await setDoc(doc(db, "users", state.uid), { cuisines: arr }, { merge: true });
    },
    subscribe(cb) {
      const col = collection(db, "users", state.uid, "restaurants");
      return onSnapshot(col, (qs) => cb(qs.docs.map((d) => ({ id: d.id, ...d.data() }))));
    },
    async add(data) {
      await addDoc(collection(db, "users", state.uid, "restaurants"), { ...data, createdAt: serverTimestamp() });
    },
    async update(id, data) {
      await setDoc(doc(db, "users", state.uid, "restaurants", id), data, { merge: true });
    },
    async remove(id) { await deleteDoc(doc(db, "users", state.uid, "restaurants", id)); },
  };
}

function demoStore() {
  let cb = null;
  const read = () => { try { return JSON.parse(localStorage.getItem(LS_RESTAURANTS)) || []; } catch { return []; } };
  const write = (arr) => { localStorage.setItem(LS_RESTAURANTS, JSON.stringify(arr)); if (cb) cb(read()); };
  return {
    demo: true,
    initAuth(onChange) { seedDemoData(); onChange({ uid: "demo", email: "Demo mode" }); },
    async getCountries() { try { return JSON.parse(localStorage.getItem(LS_COUNTRIES)); } catch { return null; } },
    async setCountries(arr) { localStorage.setItem(LS_COUNTRIES, JSON.stringify(arr)); },
    async getCuisines() { try { return JSON.parse(localStorage.getItem(LS_CUISINES)); } catch { return null; } },
    async setCuisines(arr) { localStorage.setItem(LS_CUISINES, JSON.stringify(arr)); },
    subscribe(c) { cb = c; cb(read()); return () => { cb = null; }; },
    async add(data) {
      const arr = read();
      arr.push({ id: "d" + Date.now() + Math.random().toString(36).slice(2, 6), ...data });
      write(arr);
    },
    async update(id, data) { write(read().map((r) => (r.id === id ? { ...r, ...data } : r))); },
    async remove(id) { write(read().filter((r) => r.id !== id)); },
  };
}

const store = DEMO ? demoStore() : firebaseStore();

// Sample data so the demo has something to show. Seeded once into localStorage;
// edits/additions persist in the browser until cleared.
function seedDemoData() {
  if (localStorage.getItem(LS_RESTAURANTS) !== null) return; // already seeded
  localStorage.setItem(LS_COUNTRIES, JSON.stringify(["Malaysia", "Singapore"]));
  localStorage.setItem(LS_RESTAURANTS, JSON.stringify([
    { id: "s1", name: "Village Park Restaurant", country: "Malaysia", district: "Petaling Jaya", cuisine: "Malaysian",
      address: "5, Jalan SS 21/37, Damansara Utama, Petaling Jaya", openingHours: "Mo-Su 07:00-19:00",
      phone: "+60 3-7710 7860", lat: 3.1349, lng: 101.6213,
      dishes: ["Nasi Lemak Ayam Goreng", "Beef Rendang", "Teh Tarik"] },
    { id: "s2", name: "Restoran Yut Kee", country: "Malaysia", district: "Kuala Lumpur", cuisine: "Hainanese",
      address: "1, Jalan Kamunting, Chow Kit, Kuala Lumpur", openingHours: "Tu-Su 08:00-16:00",
      phone: "+60 3-2698 8108", lat: 3.1622, lng: 101.6997,
      dishes: ["Hainanese Chicken Chop", "Roti Babi", "Kaya Toast"] },
    { id: "s3", name: "Nasi Kandar Pelita", country: "Malaysia", district: "Kuala Lumpur", cuisine: "Mamak / Indian",
      address: "Jalan Ampang, Kuala Lumpur", openingHours: "24/7",
      phone: "+60 3-4042 2020", lat: 3.1592, lng: 101.7218,
      dishes: ["Nasi Kandar Ayam", "Roti Canai", "Tandoori Chicken"] },
    { id: "s4", name: "Sushi Hibiki", country: "Malaysia", district: "Kuala Lumpur", cuisine: "Japanese",
      address: "Pavilion KL, Bukit Bintang, Kuala Lumpur", openingHours: "Mo-Su 11:30-22:00",
      phone: "+60 3-2148 8133", lat: 3.1488, lng: 101.7137,
      dishes: ["Omakase Set", "Salmon Aburi", "Chawanmushi"] },
    { id: "s5", name: "Jalan Alor Wai Sek Hai", country: "Malaysia", district: "Kuala Lumpur", cuisine: "Chinese",
      address: "Jalan Alor, Bukit Bintang, Kuala Lumpur", openingHours: "Mo-Su 17:00-02:00",
      phone: "", lat: 3.1456, lng: 101.7089,
      dishes: ["Grilled Chicken Wings", "Char Kuey Teow", "BBQ Stingray"] },
    { id: "s6", name: "Tian Tian Hainanese Chicken Rice", country: "Singapore", district: "Chinatown", cuisine: "Singaporean",
      address: "Maxwell Food Centre, 1 Kadayanallur St, Singapore", openingHours: "We-Mo 10:00-20:00",
      phone: "", lat: 1.2806, lng: 103.8447,
      dishes: ["Hainanese Chicken Rice", "Chicken Rice Ball"] },
  ]));
}

// Stand-in for /api/search when running locally (the real proxy only exists on
// Vercel). Returns plausible matches so the add flow can be demoed end to end.
function mockSearch(name, country) {
  const seed = [
    { name: "Village Park Restaurant", cuisine: "Malaysian", district: "Petaling Jaya", address: "Damansara Utama, Petaling Jaya", openingHours: "Mo-Su 07:00-19:00", phone: "+60 3-7710 7860", lat: 3.1349, lng: 101.6213 },
    { name: "Madam Kwan's", cuisine: "Malaysian", district: "Kuala Lumpur", address: "Suria KLCC, Kuala Lumpur", openingHours: "Mo-Su 11:00-22:00", phone: "+60 3-2026 2297", lat: 3.1578, lng: 101.7123 },
    { name: "Lebua Thai Kitchen", cuisine: "Thai", district: "Bangsar", address: "Bangsar, Kuala Lumpur", openingHours: "Tu-Su 11:30-22:00", phone: "", lat: 3.1289, lng: 101.6711 },
  ];
  const q = name.toLowerCase();
  const hits = seed.filter((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase().split(" ")[0]));
  const base = hits.length ? hits : [{
    name: name, cuisine: "", district: "", address: country, openingHours: "Mo-Su 10:00-22:00", phone: "", lat: 3.139, lng: 101.687,
  }];
  return base.map((b) => ({ ...b, displayName: `${b.name}, ${b.address}` }));
}

// ===========================================================================
// AUTH
// ===========================================================================
let authMode = "login";

$("tab-login").onclick = () => setAuthMode("login");
$("tab-signup").onclick = () => setAuthMode("signup");

function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-signup").classList.toggle("active", mode === "signup");
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Sign up";
  $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("auth-error").textContent = "";
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("auth-error").textContent = "";
  const email = $("auth-email").value.trim();
  const pw = $("auth-password").value;
  try {
    if (authMode === "signup") await store.signup(email, pw);
    else await store.login(email, pw);
  } catch (err) {
    $("auth-error").textContent = friendlyAuthError(err.code || err.message);
  }
});

function friendlyAuthError(code) {
  const map = {
    "auth/invalid-email": "That email doesn't look right.",
    "auth/missing-password": "Enter a password.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/email-already-in-use": "That email already has an account. Try logging in.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Wrong password.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] || "Something went wrong. Try again.";
}

$("btn-logout").onclick = () => store.logout();

// Bootstrap: wire auth state to the UI. In demo mode this fires immediately
// with a fake user; in production it follows real Firebase sign-in/out.
store.initAuth((user) => {
  if (user) {
    state.uid = user.uid;
    $("user-email").textContent = user.email;
    $("demo-banner").classList.toggle("hidden", !store.demo);
    $("btn-logout").classList.toggle("hidden", store.demo);
    hide($("auth-screen"));
    show($("app-screen"));
    startSync();
    requestLocation();
  } else {
    state.uid = null;
    if (state.unsub) { state.unsub(); state.unsub = null; }
    hide($("app-screen"));
    show($("auth-screen"));
  }
});

// ===========================================================================
// FIRESTORE SYNC
// ===========================================================================
async function startSync() {
  // Load (and seed) the user's country list.
  const saved = await store.getCountries();
  state.countries = (Array.isArray(saved) && saved.length) ? saved : ["Malaysia"];
  if (!state.countries.includes("Malaysia")) state.countries.unshift("Malaysia");
  if (!Array.isArray(saved) || !saved.length) await store.setCountries(state.countries);
  if (!state.countries.includes(state.activeCountry)) state.activeCountry = "Malaysia";

  // Load (and seed) the cuisine dropdown list.
  const savedCuisines = await store.getCuisines();
  state.cuisines = (Array.isArray(savedCuisines) && savedCuisines.length) ? savedCuisines : [...DEFAULT_CUISINES];
  if (!Array.isArray(savedCuisines) || !savedCuisines.length) await store.setCuisines(state.cuisines);

  // Live-sync restaurants.
  state.unsub = store.subscribe((restaurants) => {
    state.restaurants = restaurants;
    renderAll();
  });

  renderAll();
}

async function saveCountries() { await store.setCountries(state.countries); }
async function saveCuisines() { await store.setCuisines(state.cuisines); }
async function saveRestaurant(data) { await store.add(data); }
async function updateRestaurant(id, data) { await store.update(id, data); }
async function deleteRestaurant(id) { await store.remove(id); }

// ===========================================================================
// OPENING HOURS PARSER  (handles the common OSM subset)
// ===========================================================================
const DAY_NUM = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const DAY_ORDER = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function parseHours(str) {
  if (!str) return null;
  const s = str.trim();
  if (/^24\s*\/\s*7$/.test(s)) return [{ days: [0, 1, 2, 3, 4, 5, 6], ranges: [[0, 1440]] }];

  const rules = [];
  for (const rawRule of s.split(";")) {
    const rule = rawRule.trim();
    if (!rule) continue;
    const timeIdx = rule.search(/\d{1,2}:\d{2}/);
    let dayPart, timePart;
    if (timeIdx === -1) {
      // e.g. "Mo off" or "PH off" — treat as closed, skip
      continue;
    }
    dayPart = rule.slice(0, timeIdx).trim();
    timePart = rule.slice(timeIdx).trim();

    const days = dayPart ? parseDays(dayPart) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.length) continue;

    if (/off|closed/i.test(timePart)) continue;
    const ranges = parseTimeRanges(timePart);
    if (ranges.length) rules.push({ days, ranges });
  }
  return rules.length ? rules : null;
}

function parseDays(part) {
  const out = new Set();
  for (const tok of part.split(",")) {
    const t = tok.trim();
    const m = t.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)$/);
    if (m) {
      let i = DAY_ORDER.indexOf(m[1]);
      const end = DAY_ORDER.indexOf(m[2]);
      for (let n = 0; n < 7; n++) {
        out.add(DAY_NUM[DAY_ORDER[i]]);
        if (DAY_ORDER[i] === m[2]) break;
        i = (i + 1) % 7;
      }
      out.add(DAY_NUM[m[2]] ?? DAY_NUM[DAY_ORDER[end]]);
    } else if (DAY_NUM[t] !== undefined) {
      out.add(DAY_NUM[t]);
    }
  }
  return [...out];
}

function parseTimeRanges(part) {
  const out = [];
  for (const tok of part.split(",")) {
    const m = tok.trim().match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (m) {
      const start = (+m[1]) * 60 + (+m[2]);
      let end = (+m[3]) * 60 + (+m[4]);
      out.push([start, end]); // end<=start means crosses midnight
    }
  }
  return out;
}

// now (as {day, minutes}) in a given timezone
function nowInTz(tz) {
  let d;
  try { d = new Date(new Date().toLocaleString("en-US", { timeZone: tz })); }
  catch { d = new Date(); }
  return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

function getStatus(restaurant) {
  const rules = parseHours(restaurant.openingHours);
  if (!rules) return "unknown";
  const tz = COUNTRY_TZ[restaurant.country] || "Asia/Kuala_Lumpur";
  const { day, minutes } = nowInTz(tz);
  for (const rule of rules) {
    if (!rule.days.includes(day)) continue;
    for (const [start, end] of rule.ranges) {
      if (end > start) {
        if (minutes >= start && minutes < end) return "open";
      } else { // overnight
        if (minutes >= start || minutes < end) return "open";
      }
    }
  }
  return "closed";
}

// Build a readable Mon–Sun schedule from the opening-hours string.
function weeklySchedule(restaurant) {
  const rules = parseHours(restaurant.openingHours);
  if (!rules) return null;
  const fmt = (m) => {
    m = ((m % 1440) + 1440) % 1440;
    let h = Math.floor(m / 60); const mn = m % 60;
    const ap = h < 12 ? "AM" : "PM";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(mn).padStart(2, "0")} ${ap}`;
  };
  const tz = COUNTRY_TZ[restaurant.country] || "Asia/Kuala_Lumpur";
  const today = nowInTz(tz).day;
  const days = [["Monday", 1], ["Tuesday", 2], ["Wednesday", 3], ["Thursday", 4], ["Friday", 5], ["Saturday", 6], ["Sunday", 0]];
  return days.map(([label, d]) => {
    const ranges = [];
    for (const rule of rules) if (rule.days.includes(d)) ranges.push(...rule.ranges);
    ranges.sort((a, b) => a[0] - b[0]);
    const text = ranges.length
      ? ranges.map(([s, e]) => (s === 0 && e === 1440) ? "Open 24 hours" : `${fmt(s)} – ${fmt(e)}`).join(", ")
      : "Closed";
    return { day: label, text, isToday: d === today, closed: !ranges.length };
  });
}

// ===========================================================================
// CROWD ESTIMATE (time-of-day heuristic — not live data)
// ===========================================================================
function getCrowd(restaurant) {
  if (getStatus(restaurant) === "closed") return null;
  const tz = COUNTRY_TZ[restaurant.country] || "Asia/Kuala_Lumpur";
  const h = nowInTz(tz).minutes / 60;
  if ((h >= 12 && h < 14) || (h >= 19 && h < 21)) return { level: "high", label: "Likely busy" };
  if ((h >= 11 && h < 12) || (h >= 14 && h < 15) || (h >= 18 && h < 19) || (h >= 21 && h < 22))
    return { level: "med", label: "Moderate" };
  return { level: "low", label: "Quiet" };
}

// ===========================================================================
// DISTANCE
// ===========================================================================
function requestLocation(onResult) {
  if (!navigator.geolocation) { if (onResult) onResult("unsupported"); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => { state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderAll(); if (onResult) onResult("ok"); },
    (err) => { state.locDenied = (err.code === 1); renderAll(); if (onResult) onResult("error"); },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
  );
}

function distanceKm(restaurant) {
  if (!state.userPos || !restaurant.lat || !restaurant.lng) return null;
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(restaurant.lat - state.userPos.lat);
  const dLng = toRad(restaurant.lng - state.userPos.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(state.userPos.lat)) * Math.cos(toRad(restaurant.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mapUrl(r) {
  if (r.lat && r.lng) return `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + " " + (r.country || ""))}`;
}

// ===========================================================================
// RENDER
// ===========================================================================
function renderAll() {
  renderCountryTabs();
  renderAreaTabs();
  renderCuisineFilter();
  renderList();
}

function renderCountryTabs() {
  const nav = $("country-tabs");
  nav.innerHTML = "";
  for (const c of state.countries) {
    const b = document.createElement("button");
    b.className = "country-tab" + (c === state.activeCountry ? " active" : "");
    b.textContent = c;
    b.onclick = () => { state.activeCountry = c; state.activeDistrict = ""; state.cuisine = ""; renderAll(); };
    nav.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "country-tab country-tab-add";
  add.textContent = "+";
  add.title = "Add country";
  add.onclick = openCountryModal;
  nav.appendChild(add);
}

function renderAreaTabs() {
  const nav = $("area-tabs");
  nav.innerHTML = "";
  // Areas are derived automatically from the restaurants saved in this country.
  const inCountry = state.restaurants.filter((r) => (r.country || "Malaysia") === state.activeCountry);
  const areas = [...new Set(inCountry.map((r) => r.district).filter(Boolean))].sort();
  if (areas.length < 2) return; // nothing to filter by — hide the row entirely

  const all = document.createElement("button");
  all.className = "area-tab" + (state.activeDistrict === "" ? " active" : "");
  all.textContent = "All areas";
  all.onclick = () => { state.activeDistrict = ""; renderAll(); };
  nav.appendChild(all);

  for (const a of areas) {
    const b = document.createElement("button");
    b.className = "area-tab" + (a === state.activeDistrict ? " active" : "");
    b.textContent = a;
    b.onclick = () => { state.activeDistrict = a; renderAll(); };
    nav.appendChild(b);
  }
}

function inActiveCountry() {
  let list = state.restaurants.filter((r) => (r.country || "Malaysia") === state.activeCountry);
  if (state.activeDistrict) list = list.filter((r) => (r.district || "") === state.activeDistrict);
  return list;
}

function renderCuisineFilter() {
  const sel = $("cuisine-filter");
  const cuisines = [...new Set(inActiveCountry().map((r) => r.cuisine).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All cuisines</option>' +
    cuisines.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = state.cuisine;
  sel.onchange = () => { state.cuisine = sel.value; renderList(); };
}

function renderList() {
  const ul = $("restaurant-list");
  $("open-filter").classList.toggle("active", state.openOnly);
  let list = inActiveCountry();
  if (state.cuisine) list = list.filter((r) => r.cuisine === state.cuisine);
  if (state.openOnly) list = list.filter((r) => getStatus(r) === "open");
  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  ul.innerHTML = "";
  $("empty-state").classList.toggle("hidden", list.length > 0);
  if (!list.length) {
    $("empty-state").textContent = (state.openOnly || state.cuisine)
      ? "Nothing matches this filter right now."
      : "No restaurants here yet. Tap “Add” to start.";
  }

  for (const r of list) {
    const status = getStatus(r);
    const crowd = getCrowd(r);
    const meta = [r.cuisine, r.district].filter(Boolean).join(" · ") || "—";
    const li = document.createElement("li");
    li.className = "r-card";
    // Tapping the card opens detail — but let the Maps link do its own thing.
    li.onclick = (e) => { if (e.target.closest("a")) return; openDetail(r); };
    li.innerHTML = `
      <div class="r-card-top">
        <p class="r-name">${esc(r.name)}</p>
        <span class="status-badge status-${status}">${statusLabel(status)}</span>
      </div>
      <p class="r-meta">${esc(meta)}</p>
      <div class="r-card-bottom">
        ${crowd
          ? `<span class="chip crowd-${crowd.level}">${crowd.label}</span>`
          : `<span class="crowd-na">Crowd: —</span>`}
        <a class="map-btn-sm" href="${mapUrl(r)}" target="_blank" rel="noopener">📍 Maps</a>
      </div>`;
    ul.appendChild(li);
  }
}

function statusLabel(s) {
  return s === "open" ? "Open now" : s === "closed" ? "Closed" : "Hours unknown";
}

// ===========================================================================
// DETAIL VIEW
// ===========================================================================
function openDetail(r) {
  const status = getStatus(r);
  const crowd = getCrowd(r);
  const dist = distanceKm(r);
  const dishes = Array.isArray(r.dishes) ? r.dishes.filter(Boolean) : [];

  // Opening hours as a readable weekly schedule.
  const sched = weeklySchedule(r);
  let hoursHtml;
  if (sched) {
    hoursHtml = `<div class="hours-grid">` + sched.map((s) =>
      `<div class="hours-day${s.isToday ? " hours-today" : ""}">${s.day}</div>` +
      `<div class="hours-time${s.isToday ? " hours-today" : ""}${s.closed ? " hours-closed" : ""}">${esc(s.text)}</div>`
    ).join("") + `</div>`;
  } else if (r.openingHours) {
    hoursHtml = esc(r.openingHours);
  } else {
    hoursHtml = `<span style="color:var(--muted)">Not recorded — add via Edit</span>`;
  }

  // Distance can fail two different ways — be explicit about which.
  let distHtml;
  if (!r.lat || !r.lng) {
    distHtml = `<span style="color:var(--muted)">No map location saved — add coordinates via Edit</span>`;
  } else if (dist != null) {
    distHtml = `${dist.toFixed(dist < 10 ? 1 : 0)} km from you`;
  } else if (state.locDenied) {
    distHtml = `<button class="link-btn" id="enable-loc" type="button">Location blocked — tap to retry</button>`;
  } else {
    distHtml = `<button class="link-btn" id="enable-loc" type="button">Tap to allow location</button>`;
  }

  const row = (label, value) => `
    <div class="detail-row"><div class="label">${label}</div><div class="value">${value}</div></div>`;

  $("detail-content").innerHTML = `
    <div class="detail-head">
      <div>
        <h2 class="detail-name">${esc(r.name)}</h2>
        ${r.cuisine ? `<p class="detail-cuisine">${esc(r.cuisine)}</p>` : ""}
      </div>
      <span class="status-badge status-${status}">${statusLabel(status)}</span>
    </div>
    <div class="detail-rows">
      ${row("Area", esc([r.district, r.country].filter(Boolean).join(", ") || "—"))}
      ${row("Address", esc(r.address || "—"))}
      ${row("Opening hours", hoursHtml)}
      ${row("Contact", r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—")}
      ${row("Crowd level", crowd ? `<span class="chip crowd-${crowd.level}">${crowd.label}</span> <span style="color:var(--muted);font-size:.8rem">(estimate)</span>` : "—")}
      ${row("Distance", distHtml)}
      ${row("Map", `<a class="map-btn" href="${mapUrl(r)}" target="_blank" rel="noopener">Open in Google Maps</a>`)}
      ${row("Recommended dishes", dishes.length ? `<ul class="dish-list">${dishes.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "—")}
    </div>
    <div class="detail-actions">
      <button class="btn-danger" id="detail-delete" type="button">Delete</button>
      <button class="btn-ghost" id="detail-edit" type="button">Edit</button>
      <button class="btn-ghost" id="detail-close" type="button">Close</button>
    </div>`;

  show($("detail-modal"));
  $("detail-close").onclick = () => hide($("detail-modal"));
  $("detail-edit").onclick = () => openEditRestaurant(r);
  const enableLoc = document.getElementById("enable-loc");
  if (enableLoc) enableLoc.onclick = () => { enableLoc.textContent = "Locating…"; requestLocation(() => openDetail(r)); };
  $("detail-delete").onclick = async () => {
    if (confirm(`Delete "${r.name}"?`)) { await deleteRestaurant(r.id); hide($("detail-modal")); }
  };
}

$("detail-modal").addEventListener("click", (e) => { if (e.target.id === "detail-modal") hide($("detail-modal")); });

// ===========================================================================
// ADD COUNTRY
// ===========================================================================
function openCountryModal() { $("country-input").value = ""; show($("country-modal")); $("country-input").focus(); }
$("country-save").onclick = async () => {
  const name = $("country-input").value.trim();
  if (!name) return;
  const clean = name.replace(/\b\w/g, (c) => c.toUpperCase());
  if (!state.countries.includes(clean)) { state.countries.push(clean); await saveCountries(); }
  state.activeCountry = clean;
  hide($("country-modal"));
  renderAll();
};
document.querySelectorAll("[data-close-country]").forEach((b) => b.onclick = () => hide($("country-modal")));

// ===========================================================================
// SETTINGS — manage the cuisine dropdown list
// ===========================================================================
$("btn-settings").onclick = () => { renderCuisineEditor(); show($("settings-modal")); };

function renderCuisineEditor() {
  const ul = $("cuisine-list");
  ul.innerHTML = "";
  state.cuisines.forEach((c) => {
    const li = document.createElement("li");
    li.className = "chip-edit";
    li.innerHTML = `<span>${esc(c)}</span><button type="button" aria-label="Remove ${esc(c)}">×</button>`;
    li.querySelector("button").onclick = async () => {
      state.cuisines = state.cuisines.filter((x) => x !== c);
      await saveCuisines();
      renderCuisineEditor();
    };
    ul.appendChild(li);
  });
}

async function addCuisine() {
  const input = $("cuisine-new");
  const val = titleCase(input.value.trim());
  if (val && !state.cuisines.includes(val)) {
    state.cuisines.push(val);
    await saveCuisines();
    renderCuisineEditor();
  }
  input.value = "";
  input.focus();
}
$("cuisine-add").onclick = addCuisine;
$("cuisine-new").addEventListener("keydown", (e) => { if (e.key === "Enter") addCuisine(); });
document.querySelectorAll("[data-close-settings]").forEach((b) => b.onclick = () => hide($("settings-modal")));
$("settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") hide($("settings-modal")); });

// ===========================================================================
// ADD RESTAURANT
// ===========================================================================
$("open-filter").onclick = () => { state.openOnly = !state.openOnly; renderList(); };

// ----- Per-day opening-hours editor -----------------------------------------
// Mon–Sun rows with open toggle + from/to times. Converts to/from the OSM-style
// string the rest of the app already understands, so status/schedule logic is unchanged.
const HOURS_DAYS = [["Monday", "Mo"], ["Tuesday", "Tu"], ["Wednesday", "We"], ["Thursday", "Th"], ["Friday", "Fr"], ["Saturday", "Sa"], ["Sunday", "Su"]];
const CODE_NUM = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };

function minToHHMM(m) { if (m >= 1440) m = 1439; const h = Math.floor(m / 60), mn = m % 60; return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`; }

function hoursStringToByDay(str) {
  const rules = parseHours(str);
  const byDay = {};
  if (!rules) return byDay;
  for (const [, code] of HOURS_DAYS) {
    const num = CODE_NUM[code];
    for (const rule of rules) {
      if (rule.days.includes(num) && rule.ranges.length) {
        const [s, e] = rule.ranges[0];
        byDay[code] = { from: minToHHMM(s), to: minToHHMM(e) };
        break;
      }
    }
  }
  return byDay;
}

function renderHoursEditor(byDay) {
  const wrap = $("hours-editor");
  wrap.innerHTML = "";
  for (const [label, code] of HOURS_DAYS) {
    const open = !!byDay[code];
    const from = (byDay[code] && byDay[code].from) || "09:00";
    const to = (byDay[code] && byDay[code].to) || "22:00";
    const row = document.createElement("div");
    row.className = "he-row" + (open ? "" : " closed");
    row.dataset.code = code;
    row.innerHTML = `
      <label class="he-day"><input type="checkbox" class="he-open" ${open ? "checked" : ""}> ${label}</label>
      <div class="he-times">
        <input type="time" class="he-from" value="${from}">
        <span>–</span>
        <input type="time" class="he-to" value="${to}">
      </div>`;
    const cb = row.querySelector(".he-open");
    cb.onchange = () => row.classList.toggle("closed", !cb.checked);
    wrap.appendChild(row);
  }
}

function collectHoursString() {
  const parts = [];
  for (const row of $("hours-editor").querySelectorAll(".he-row")) {
    if (!row.querySelector(".he-open").checked) continue;
    const from = row.querySelector(".he-from").value;
    const to = row.querySelector(".he-to").value;
    if (from && to && from !== to) parts.push(`${row.dataset.code} ${from}-${to}`);
  }
  return parts.join("; ");
}

$("hours-copy").onclick = () => {
  const rows = [...$("hours-editor").querySelectorAll(".he-row")];
  if (!rows.length) return;
  const mon = rows[0];
  const openMon = mon.querySelector(".he-open").checked;
  const from = mon.querySelector(".he-from").value;
  const to = mon.querySelector(".he-to").value;
  rows.forEach((r) => {
    r.querySelector(".he-open").checked = openMon;
    r.querySelector(".he-from").value = from;
    r.querySelector(".he-to").value = to;
    r.classList.toggle("closed", !openMon);
  });
};

// Fill the cuisine dropdown from the managed list, keeping the current value
// selectable even if it isn't in the list (e.g. an auto-filled OSM cuisine).
function populateCuisineSelect(selected) {
  const sel = $("f-cuisine");
  const list = [...state.cuisines];
  if (selected && !list.includes(selected)) list.unshift(selected);
  sel.innerHTML = `<option value="">— Select cuisine —</option>` +
    list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = selected || "";
}

// Offer areas already used in this country as type-ahead suggestions.
function populateDistrictOptions() {
  const areas = [...new Set(state.restaurants
    .filter((r) => (r.country || "Malaysia") === state.activeCountry)
    .map((r) => r.district).filter(Boolean))].sort();
  $("district-options").innerHTML = areas.map((a) => `<option value="${esc(a)}"></option>`).join("");
}

$("btn-add").onclick = () => {
  state.editingId = null;
  $("add-title").textContent = "Add restaurant";
  $("search-name").value = "";
  $("search-results").innerHTML = "";
  $("search-status").textContent = "";
  $("search-country-label").textContent = state.activeCountry;
  populateDistrictOptions();
  populateCuisineSelect("");
  renderHoursEditor({});
  show($("add-step-search"));
  hide($("add-step-edit"));
  show($("add-modal"));
  $("search-name").focus();
};
document.querySelectorAll("[data-close-add]").forEach((b) => b.onclick = () => hide($("add-modal")));
$("add-modal").addEventListener("click", (e) => { if (e.target.id === "add-modal") hide($("add-modal")); });

$("search-go").onclick = runSearch;
$("search-name").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

async function runSearch() {
  const name = $("search-name").value.trim();
  if (!name) return;
  $("search-results").innerHTML = "";
  $("search-status").textContent = "Searching…";
  try {
    let results;
    if (store.demo) {
      results = mockSearch(name, state.activeCountry);
    } else {
      const res = await fetch(`/api/search?name=${encodeURIComponent(name)}&country=${encodeURIComponent(state.activeCountry)}`);
      const data = await res.json();
      results = data.results || [];
    }
    if (!results.length) {
      $("search-status").innerHTML = `Not found in the map database. Try a different spelling, or tap <strong>“Add it manually”</strong> below to enter it yourself.`;
      return;
    }
    $("search-status").textContent = `${results.length} match${results.length > 1 ? "es" : ""} — pick one:`;
    const ul = $("search-results");
    results.forEach((r) => {
      const li = document.createElement("li");
      li.className = "search-result";
      li.innerHTML = `<div class="sr-name">${esc(r.name)}</div><div class="sr-addr">${esc(r.address || r.displayName)}</div>`;
      li.onclick = () => fillEditForm({
        name: r.name, cuisine: r.cuisine, district: r.district, address: r.address,
        openingHours: r.openingHours, phone: r.phone,
        lat: r.lat ? parseFloat(r.lat) : "", lng: r.lng ? parseFloat(r.lng) : "",
      });
      ul.appendChild(li);
    });
  } catch (err) {
    $("search-status").textContent = "Lookup failed. You can still enter details manually below.";
  }
}

$("manual-entry").onclick = () => fillEditForm({});

function fillEditForm(d) {
  $("f-name").value = d.name || $("search-name").value.trim();
  populateCuisineSelect(d.cuisine || "");
  $("f-address").value = d.address || "";
  renderHoursEditor(hoursStringToByDay(d.openingHours || ""));
  $("f-phone").value = d.phone || "";
  $("f-lat").value = d.lat ?? "";
  $("f-lng").value = d.lng ?? "";
  $("f-district").value = d.district || state.activeDistrict || "";
  $("f-dishes").value = "";
  hide($("add-step-search"));
  show($("add-step-edit"));
}

// Open the edit form pre-filled with an existing restaurant's details.
function openEditRestaurant(r) {
  state.editingId = r.id;
  $("add-title").textContent = "Edit restaurant";
  populateDistrictOptions();
  $("f-name").value = r.name || "";
  populateCuisineSelect(r.cuisine || "");
  $("f-address").value = r.address || "";
  renderHoursEditor(hoursStringToByDay(r.openingHours || ""));
  $("f-phone").value = r.phone || "";
  $("f-lat").value = r.lat ?? "";
  $("f-lng").value = r.lng ?? "";
  $("f-district").value = r.district || "";
  $("f-dishes").value = Array.isArray(r.dishes) ? r.dishes.join(", ") : "";
  hide($("detail-modal"));
  hide($("add-step-search"));
  show($("add-step-edit"));
  show($("add-modal"));
}

$("save-restaurant").onclick = async () => {
  const name = titleCase($("f-name").value.trim());
  if (!name) { alert("Give it a name at least."); return; }
  const lat = parseFloat($("f-lat").value);
  const lng = parseFloat($("f-lng").value);
  const data = {
    name,
    country: state.activeCountry,
    district: titleCase($("f-district").value.trim()),
    cuisine: titleCase($("f-cuisine").value.trim()),
    address: $("f-address").value.trim(),
    openingHours: collectHoursString(),
    phone: $("f-phone").value.trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    dishes: $("f-dishes").value.split(",").map((s) => titleCase(s.trim())).filter(Boolean),
  };
  if (state.editingId) {
    await updateRestaurant(state.editingId, data);
    state.editingId = null;
  } else {
    await saveRestaurant(data);
  }
  hide($("add-modal"));
};

// Re-evaluate Open/Closed + crowd every minute so badges stay live.
setInterval(() => { if (state.uid) renderList(); }, 60000);

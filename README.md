# My Food Finder

Track your favourite restaurants — auto-filled from OpenStreetMap, synced to your
account with Firebase. Country tabs (Malaysia by default), auto-generated
state/district chips (derived from each restaurant's address), cuisine filter,
"Open now" filter, live Open/Closed status, crowd estimate, distance from you,
map link and dish notes. Each restaurant card shows status, crowd level and a
one-tap Maps button without opening the detail view.

No Google Cloud billing or API key needed.

---

## Add it to your phone's home screen

Once deployed, open the site on your phone and install it — it then opens
full-screen like a native app, with the My Food Finder icon.

- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** menu (⋮) → **Add to Home screen** / **Install app**.

---

## See it before you deploy (demo mode)

When the site runs locally (or before Firebase is configured), it starts in
**demo mode**: no login, sample restaurants, everything saved in the browser only.
Use it to confirm the app does what you want. Once you deploy with a real Firebase
config, the live account-backed version takes over automatically.

---

## What you need to do (one-time setup)

### 1. Firebase — turn on Email login + the database

1. Go to **console.firebase.google.com** → open your project (or create one).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
3. **Build → Firestore Database → Create database → Start in production mode →** pick a location → Enable.
4. Firestore → **Rules** tab, paste this and **Publish** (locks data to each signed-in user):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       // Each user can read/write only their own data.
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       // Admin (you) can read/write every user's profile — powers the Admin dashboard.
       match /users/{uid} {
         allow read, write: if request.auth != null
           && request.auth.token.email == "wingloon@gmail.com";
       }
     }
   }
   ```

### 2. Get your config

1. Firebase → **Project settings** (gear icon) → **Your apps** → Web app (`</>`).
   Register an app if you don't have one — no hosting needed.
2. Copy the `firebaseConfig` values.
3. Paste them into **`firebase-config.js`**, replacing the `PASTE_...` placeholders.

### 3. Deploy (your usual flow)

1. Push this folder to a GitHub repo.
2. In Vercel → **Add New → Project → import the repo → Deploy.**
   No build settings needed — it's a static site, and `/api/search.js` becomes a
   serverless function automatically.

### 4. Authorise the domain

In Firebase → **Authentication → Settings → Authorized domains**, add your Vercel
URL (e.g. `your-app.vercel.app`). Then open the site, **Sign up** with your email,
and start adding restaurants.

---

## Notes on the data

- **Auto-fill** comes from OpenStreetMap. Well-known places fill in fully; smaller
  ones may be missing hours or phone — just type those in, every field is editable.
- **Open/Closed** is computed live from the opening hours in the restaurant's local time.
- **Crowd level** is a time-of-day estimate (busy at lunch & dinner), not live data —
  Google's "popular times" isn't available through any public API.
- **Distance** uses your device location (you'll be asked for permission).
- **Map** opens Google Maps at the restaurant's coordinates.

---

## Admin dashboard

When you sign in as **wingloon@gmail.com**, an **Admin** button appears in the top bar.
It lists every user, their auto-fill lookups used this month, lets you set a
**monthly limit** per user, and **disable / re-enable** any user. A disabled user is
bounced to the login screen (with a message) the next time the app loads. Access to
other users' data is enforced by the admin Firestore rule above — not just the hidden
button.

> The dashboard *displays and sets* limits. It does **not yet hard-enforce** them —
> that needs the server piece below.

## Switching to Google data + enforcing limits (next phase)

To auto-pull name/address/hours/location/distance from **Google** (instead of free
OpenStreetMap) and to actually stop a user exceeding their limit, two things are needed:

1. **Google Cloud:** a project with **billing enabled**, the **Places API** and
   **Distance Matrix API** turned on, and an **API key**.
2. **Firebase service account:** Firebase → Project settings → Service accounts →
   *Generate new private key*. This lets a server function verify who's calling and
   read/increment their usage securely.

With those, the app gets a new server function (`/api/places`) that: verifies the
user's Firebase token → checks their usage vs. limit in Firestore → if under, calls
Google and increments their count → if over, refuses. That's the only way a per-user
limit can truly protect your Google bill (a browser-only limit can be bypassed).

Tell Claude when you have the Google key + service account and it'll wire this up.

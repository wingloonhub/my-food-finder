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
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
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

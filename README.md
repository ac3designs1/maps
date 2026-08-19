# Trips

Google Maps–style trip planner. No 10-stop limit. Autocomplete, optimise, save, edit anytime.

**Use it on your phone (no App Store):** [https://maps-8aw4.onrender.com](https://maps-8aw4.onrender.com)

- **iPhone:** Safari → Share → **Add to Home Screen**
- **Android:** Chrome → menu → **Add to Home screen** / **Install app**

Trips stay on the phone. Push to GitHub and Render updates the home-screen app on the next open.

## App Store and Play Store

Native iOS + Android projects live in `ios/` and `android/` if you want the stores later. Full steps: **[native/README.md](native/README.md)**.

## Deploy on Render

1. Push this repo to GitHub (`ac3designs1/maps`).
2. In [Render](https://dashboard.render.com) → **New** → **Web Service** → connect that repo.
3. Render should pick these up from `render.yaml`. If you set it by hand:

   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance:** Free is fine to try; it sleeps after ~15 minutes. For always-on, use a paid instance (or ping `/health` every 10 minutes).
   - **Node version:** `22`

4. Deploy. Live site: [https://maps-8aw4.onrender.com](https://maps-8aw4.onrender.com).

Trips are saved on the phone (so they survive Render restarts).

## Google search (recommended)

Autocomplete uses **Google Places** when a key is set — much better for shops, businesses, and addresses in Australia.

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → **Enable**:
   - **Places API (New)**
   - **Geocoding API**
   - **Directions API** (routes)
2. Create an API key → restrict it (HTTP referrers for your `onrender.com` URL, or IP for server-only).
3. Set env var **`GOOGLE_MAPS_API_KEY`** on Render (Environment) or locally in `.env` / shell.
4. Redeploy. `/health` returns `googlePlaces: true` when the key is loaded.

Without a key, search falls back to OpenStreetMap (many businesses won’t appear).

## Local

```
npm install
npm start
```

Then `http://192.168.x.x:3860` on the same Wi‑Fi.

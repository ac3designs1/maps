# Trips

Google Maps–style trip planner for iPhone. No 10-stop limit. Autocomplete, optimize, save, edit anytime.

Live URL after Render: your `onrender.com` link. On the phone: Safari → Share → **Add to Home Screen**.

## Deploy on Render

1. Push this repo to GitHub (`ac3designs1/maps`).
2. In [Render](https://dashboard.render.com) → **New** → **Web Service** → connect that repo.
3. Render should pick these up from `render.yaml`. If you set it by hand:

   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance:** Free is fine to try; it sleeps after ~15 minutes. For always-on, use a paid instance (or ping `/health` every 10 minutes).
   - **Node version:** `22`

4. Deploy. Open `https://<your-service>.onrender.com` on the iPhone.

Trips are saved on the phone (so they survive Render restarts). The server also stores a backup when it can.

## Google search (recommended)

Autocomplete uses **Google Places** when a key is set — much better for shops, businesses, and addresses in Australia.

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → **Enable**:
   - **Places API (New)**
   - **Geocoding API**
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

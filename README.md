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

## Local

```
npm install
npm start
```

Then `http://192.168.x.x:3860` on the same Wi‑Fi.

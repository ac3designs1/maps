# Native iOS + Android app

The store apps are a **Capacitor shell**. After you set your live Render URL and submit once, **pushing to Render updates the app the next time someone opens it**. Apple and Google do not review those web updates.

They still review the **native binary** the first time, and again if you change plugins, permissions, or what the app is for.

This PC can build **Android**. **iPhone builds need a Mac** (Xcode). Nobody can skip Apple Developer (~A$99/year) or Google Play Console (~US$25) — those accounts are yours.

## Live updates (do this before the first store build)

1. Open `native/live-url.json` and put your real site, no trailing slash:

```json
{ "url": "https://maps-8aw4.onrender.com" }
```

2. Run:

```
npm run native:sync
```

That URL is baked into the store binary. The HTML/CSS/JS at that URL can change whenever you deploy. Changing the URL itself needs a new store build.

Privacy policy URL for both stores: `https://maps-8aw4.onrender.com/privacy.html`

Free Render **sleeps**. A store app that loads a sleeping site looks broken. Use a paid always-on instance before you submit.

## Android (this PC)

1. Install [Android Studio](https://developer.android.com/studio).
2. `npm run native:android` (or open the `android` folder).
3. Create an upload keystore. Keep it private — never commit `.jks` / `.keystore`.
4. Build → Generate Signed Bundle → **Android App Bundle (.aab)**.
5. [Play Console](https://play.google.com/console) → Create app → listing, phone screenshots, Data safety → upload the .aab.

Package id: `com.ac3designs.trips`

Data safety (honest answers for this app): location (to start a trip), on-device trip data, no account, no ads, data sent to your server and Google Maps Platform for search/routes.

## iPhone from Windows (Codemagic)

You cannot archive with Xcode on this PC. Use [Codemagic](https://codemagic.io) (already connected to `ac3designs1/maps`).

1. Apple Developer Program (~A$99/year) and an app in [App Store Connect](https://appstoreconnect.apple.com) with bundle id `com.ac3designs.trips`.
2. Codemagic → Team integrations:
   - **App Store Connect API key**, name it exactly `codemagic` (App Manager access)
3. Click **Check for configuration files**, then start **Trips iOS (TestFlight)**.
   The workflow creates the App Store certificate and profile on Apple if they are missing.
4. The first successful build lands in **TestFlight**. App Review still needs screenshots and the privacy URL in App Store Connect.

`codemagic.yaml` is in the repo root. Do not turn on App Review auto-submit until the listing is filled in.

## iPhone on a Mac

You can still archive locally if you have a Mac:

1. Copy this repo onto a Mac. Install Xcode and CocoaPods (Capacitor 8 uses SPM; CocoaPods is optional).
2. `npm install` then `npm run native:sync`
3. `npm run native:ios`
4. In Xcode: select your Team (paid Apple Developer), bump version if needed, **Product → Archive**, upload to App Store Connect.
5. App Store Connect: listing, **1024 icon** (already in the Xcode project), iPhone screenshots, privacy URL.

Bundle id: `com.ac3designs.trips`

Location copy already in Info.plist: used to start trips from Your location and rank nearby places.

## After it is on the stores

Ship in git as usual. **Render deploy = live update** inside the installed app.

Only run `npm run native:sync` and a new store build if you change native code (plugins, permissions, splash, app id).

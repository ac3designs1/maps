import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let liveUrl = "";
try {
  const live = JSON.parse(readFileSync(join(root, "native", "live-url.json"), "utf8"));
  liveUrl = String(live?.url || "").trim();
} catch {
  liveUrl = "";
}
const liveOk = /^https:\/\/[a-z0-9.-]+/i.test(liveUrl) && !/REPLACE-WITH-YOUR/i.test(liveUrl);

const config = {
  appId: "com.ac3designs.trips",
  appName: "Trips",
  webDir: "public",
  backgroundColor: "#F2F2F7",
  android: {
    allowMixedContent: false,
    adjustMarginsForEdgeToEdge: "auto",
  },
  ios: {
    contentInset: "never",
    scrollEnabled: false,
    preferredContentMode: "mobile",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#F2F2F7",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
    },
  },
};

if (liveOk) {
  const host = new URL(liveUrl).hostname;
  config.server = {
    url: liveUrl.replace(/\/$/, ""),
    androidScheme: "https",
    errorPath: "offline.html",
    allowNavigation: [host],
  };
}

writeFileSync(join(root, "capacitor.config.json"), JSON.stringify(config, null, 2) + "\n");
console.log(liveOk ? `Capacitor live URL: ${config.server.url}` : "Capacitor using bundled public/ (set native/live-url.json for store OTA)");

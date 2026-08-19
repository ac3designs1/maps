import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const locWhen = "Trips uses your location to start a trip from where you are and to rank nearby places.";

function insertPlistKey(xml, key, block) {
  if (xml.includes(`<key>${key}</key>`)) return xml;
  return xml.replace("</dict>\n</plist>", `  ${block}\n</dict>\n</plist>`);
}

function patchIos() {
  const plistPath = join(root, "ios", "App", "App", "Info.plist");
  if (!existsSync(plistPath)) {
    console.log("skip iOS Info.plist (no ios project yet)");
    return;
  }
  let xml = readFileSync(plistPath, "utf8");
  xml = insertPlistKey(xml, "NSLocationWhenInUseUsageDescription", `<key>NSLocationWhenInUseUsageDescription</key>\n  <string>${locWhen}</string>`);
  xml = insertPlistKey(xml, "NSLocationAlwaysAndWhenInUseUsageDescription", `<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>\n  <string>${locWhen}</string>`);
  xml = insertPlistKey(xml, "NSLocationAlwaysUsageDescription", `<key>NSLocationAlwaysUsageDescription</key>\n  <string>${locWhen}</string>`);
  xml = insertPlistKey(xml, "ITSAppUsesNonExemptEncryption", "<key>ITSAppUsesNonExemptEncryption</key>\n  <false/>");
  if (!xml.includes("<key>LSApplicationQueriesSchemes</key>")) {
    xml = insertPlistKey(
      xml,
      "LSApplicationQueriesSchemes",
      `<key>LSApplicationQueriesSchemes</key>\n  <array>\n    <string>waze</string>\n    <string>comgooglemaps</string>\n    <string>tel</string>\n  </array>`,
    );
  }
  xml = xml.replace(
    /<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<\/array>/,
    "<key>UISupportedInterfaceOrientations</key>\n\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>",
  );
  xml = xml.replace("<string>armv7</string>", "<string>arm64</string>");
  writeFileSync(plistPath, xml);

  const pbx = join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
  if (existsSync(pbx)) {
    let proj = readFileSync(pbx, "utf8");
    proj = proj.replace(/TARGETED_DEVICE_FAMILY = "1,2";/g, "TARGETED_DEVICE_FAMILY = 1;");
    writeFileSync(pbx, proj);
  }
  console.log("patched ios Info.plist");
}

function patchAndroid() {
  const manifestPath = join(root, "android", "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(manifestPath)) {
    console.log("skip AndroidManifest (no android project yet)");
    return;
  }
  let xml = readFileSync(manifestPath, "utf8");
  if (!xml.includes("xmlns:tools=")) {
    xml = xml.replace(
      "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">",
      "<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"\n    xmlns:tools=\"http://schemas.android.com/tools\">",
    );
  }
  const perms = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
  ];
  for (const p of perms) {
    if (xml.includes(`android:name="${p}"`)) continue;
    xml = xml.replace(
      "<application",
      `    <uses-permission android:name="${p}" />\n    <application`,
    );
  }
  if (!xml.includes("android.hardware.location.gps")) {
    xml = xml.replace(
      "<application",
      `    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n    <application`,
    );
  }
  if (!xml.includes("com.google.android.gms.permission.AD_ID")) {
    xml = xml.replace(
      "<application",
      "    <uses-permission android:name=\"com.google.android.gms.permission.AD_ID\" tools:node=\"remove\" />\n    <application",
    );
  }
  if (!xml.includes("android:usesCleartextTraffic")) {
    xml = xml.replace("<application", '<application\n        android:usesCleartextTraffic="false"');
  }
  if (!xml.includes("android:screenOrientation")) {
    xml = xml.replace(
      'android:exported="true">',
      'android:exported="true"\n            android:screenOrientation="portrait">',
    );
  }
  if (!xml.includes("<queries>")) {
    xml = xml.replace(
      "</manifest>",
      `    <queries>
        <package android:name="com.waze" />
        <package android:name="com.google.android.apps.maps" />
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="geo" />
        </intent>
        <intent>
            <action android:name="android.intent.action.DIAL" />
            <data android:scheme="tel" />
        </intent>
    </queries>
</manifest>`,
    );
  }
  writeFileSync(manifestPath, xml);
  console.log("patched AndroidManifest.xml");
}

patchIos();
patchAndroid();

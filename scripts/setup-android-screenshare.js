const fs = require("fs");
const path = require("path");

const root = process.cwd();
const androidJavaDir = path.join(root, "android", "app", "src", "main", "java", "com", "cineverse", "lotte");
fs.mkdirSync(androidJavaDir, { recursive: true });

// 1. Copy native Android Java files
for (const file of ["ReplayKitBridgePlugin.java", "ScreenCaptureService.java"]) {
  fs.copyFileSync(
    path.join(root, "android-native-template", file),
    path.join(androidJavaDir, file)
  );
}

// 2. Register ReplayKitBridgePlugin in MainActivity.java
const mainActivityPath = path.join(androidJavaDir, "MainActivity.java");
let mainActivity = fs.readFileSync(mainActivityPath, "utf8");
if (!mainActivity.includes("ReplayKitBridgePlugin.class")) {
  if (!mainActivity.includes("import android.os.Bundle;")) {
    mainActivity = mainActivity.replace(
      "import com.getcapacitor.BridgeActivity;",
      "import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;"
    );
  }
  if (mainActivity.includes("super.onCreate(savedInstanceState);")) {
    mainActivity = mainActivity.replace(
      "super.onCreate(savedInstanceState);",
      "registerPlugin(ReplayKitBridgePlugin.class);\n        super.onCreate(savedInstanceState);"
    );
  } else {
    mainActivity = mainActivity.replace(
      "public class MainActivity extends BridgeActivity {",
      "public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(ReplayKitBridgePlugin.class);\n        super.onCreate(savedInstanceState);\n    }"
    );
  }
  fs.writeFileSync(mainActivityPath, mainActivity, "utf8");
}

// 3. Patch AndroidManifest.xml with MediaProjection + Audio + ForegroundService permissions
const manifestPath = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");
let manifest = fs.readFileSync(manifestPath, "utf8");

const requiredPermissions = [
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK"
];

for (const perm of requiredPermissions) {
  if (!manifest.includes(perm)) {
    manifest = manifest.replace(
      "<application",
      `    <uses-permission android:name="${perm}" />\n\n    <application`
    );
  }
}

if (!manifest.includes("ScreenCaptureService")) {
  manifest = manifest.replace(
    "</application>",
    `        <service\n            android:name=".ScreenCaptureService"\n            android:exported="false"\n            android:foregroundServiceType="mediaProjection" />\n    </application>`
  );
}
fs.writeFileSync(manifestPath, manifest, "utf8");

// 4. Add WebRTC Android SDK to app/build.gradle
const appGradlePath = path.join(root, "android", "app", "build.gradle");
let appGradle = fs.readFileSync(appGradlePath, "utf8");
if (!appGradle.includes("io.github.webrtc-sdk:android")) {
  appGradle = appGradle.replace(
    "dependencies {",
    `dependencies {\n    implementation 'io.github.webrtc-sdk:android:125.6422.07'`
  );
  fs.writeFileSync(appGradlePath, appGradle, "utf8");
}

console.log("[setup-android-screenshare] Configured Android MediaProjection + WebRTC + ScreenCaptureService successfully.");

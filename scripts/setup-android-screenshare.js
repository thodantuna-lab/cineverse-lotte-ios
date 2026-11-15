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
      "import android.Manifest;\nimport android.content.pm.PackageManager;\nimport android.media.AudioManager;\nimport android.os.Build;\nimport android.os.Bundle;\nimport androidx.core.app.ActivityCompat;\nimport androidx.core.content.ContextCompat;\nimport com.getcapacitor.BridgeActivity;"
    );
  }
  const onCreateBody = `registerPlugin(ReplayKitBridgePlugin.class);
        super.onCreate(savedInstanceState);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS }, 9420);
            } else {
                ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO }, 9420);
            }
        }`;
  if (mainActivity.includes("super.onCreate(savedInstanceState);")) {
    mainActivity = mainActivity.replace(
      "super.onCreate(savedInstanceState);",
      onCreateBody
    );
  } else {
    mainActivity = mainActivity.replace(
      "public class MainActivity extends BridgeActivity {",
      `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        ${onCreateBody}\n    }`
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
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
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
    `        <service\n            android:name=".ScreenCaptureService"\n            android:exported="false"\n            android:foregroundServiceType="mediaProjection|microphone" />\n    </application>`
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

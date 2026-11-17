# CineVerse Lotte — Member Web & Mobile App (Android / iOS)

## Cấu trúc thư mục

- `index.html` — Giao diện chính Web Member (GitHub Pages & Capacitor WebView).
- `assets/` — Logo, icon app, QR fallback, poster phim và sprite nhân vật.
- `android-native-template/` — Mã nguồn native Android (MediaProjection / ScreenCapture / KeepAliveWebView).
- `ios-native-template/` — Mã nguồn native iOS (ReplayKit Broadcast Extension / Bridge).
- `scripts/` — Script cấu hình native khi build Capacitor (`setup-android-screenshare.js`, `setup-ios-replaykit.rb`).
- `backend/` — Cloudflare Worker (`cloudflare-worker.js`) và cấu hình bảo mật Firebase (`firebase-database.rules.json`).
- `tools/media/` — Công cụ tạo phụ đề `.srt` bằng Whisper GPU, chuyển đổi HLS và upload video lên Cloudflare R2.
- `docs/` — Tài liệu hướng dẫn cài đặt iOS và bảo mật tên miền.
- `releases/` — File APK/IPA đã build từ GitHub Actions.
- `archive/` — Lưu trữ file nén dự phòng (không đẩy lên Git).
- `.github/workflows/` — GitHub Actions tự động build Android APK & iOS IPA.

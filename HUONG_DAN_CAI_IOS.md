# Hướng dẫn build & cài App iOS (CineVerse Lotte) lên iPhone / iPad

Dự án đã được cấu hình sẵn **Capacitor iOS + ReplayKit Broadcast Extension (`com.cineverse.lotte.ReplayKitExtension`)** để chạy đầy đủ mọi tính năng hiện có, bao gồm **Share Màn Hình hệ thống iOS/iPadOS** giống app Discord.

## Bước 1: Đẩy mã nguồn lên GitHub
Mở PowerShell tại thư mục `C:\Users\admin\.gemini\antigravity\scratch\cineverse-lotte` và đẩy lên một repo GitHub của bạn (file `.gitignore` đã tự loại bỏ `Webxemphim.zip` và `.venv` nên đẩy lên rất nhanh):

```powershell
git init
git add .
git commit -m "Add Capacitor iOS + ReplayKit build"
git branch -M main
git remote add origin https://github.com/<TEN_GITHUB_CUA_BAN>/<TEN_REPO>.git
git push -u origin main
```

## Bước 2: Tải file `.ipa` từ GitHub Actions (Build trên Mac Cloud miễn phí)
1. Vào repo GitHub của bạn → mở tab **Actions**.
2. Chọn workflow **Build iOS IPA (CineVerse Lotte)** → bấm **Run workflow** (hoặc chờ workflow tự chạy sau khi push).
3. Khi build xong (tầm 4–6 phút, hiện dấu tích xanh), kéo xuống mục **Artifacts** và tải **`CineVerse-Lotte-iOS-IPA`** về máy Windows (giải nén ra file `CineVerse-Lotte-unsigned.ipa`).

## Bước 3: Cài lên iPad / iPhone bằng Sideloadly (trên Windows)
1. Cài **Sideloadly** (https://sideloadly.io) và **iTunes** (bản tải từ Apple, không phải Microsoft Store) trên Windows.
2. Cắm iPad / iPhone vào máy tính bằng cáp USB (hoặc bật Wi-Fi sync).
3. Mở Sideloadly → kéo file `CineVerse-Lotte-unsigned.ipa` vào → nhập Apple ID miễn phí → bấm **Start**.
4. Trên iPad/iPhone: vào **Cài đặt → Cài đặt chung → Quản lý VPN & Thiết bị** → bấm **Tin cậy (Trust)** Apple ID của bạn.
5. Mở app **CineVerse Lotte** → vào **Phòng Stream** → bấm **Share Màn Hình**, bảng **Bắt đầu phát sóng (ReplayKit)** của iOS sẽ bật lên để bạn share toàn màn hình iPad/iPhone cho cả phòng xem!

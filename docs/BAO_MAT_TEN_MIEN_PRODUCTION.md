# Hướng Dẫn Bảo Mật Tối Đa Khi Thuê Tên Miền Chính Thức (Production)

Hệ thống CineVerse Lotte đã được tích hợp sẵn bảo vệ ở tầng **Cloudflare Worker**, **Web Member**, **Web Admin** và **Firebase RTDB Rules**. Khi bạn mua tên miền riêng (ví dụ `cineverse.vn` / `admin.cineverse.vn`), hãy làm đủ 6 bước sau để đạt mức bảo mật & chống sập tối đa:

## 1. Đưa Tên Miền Qua Cloudflare Proxy (Chống DDoS Layer 3/4/7 miễn phí)
- Thêm tên miền vào **Cloudflare DNS**, đảm bảo biểu tượng **Đám mây cam (Proxied)** luôn bật cho cả web Member (`@` / `www`) và web Admin (`admin`).
- Bật **SSL/TLS → Full (Strict)** và bật **Always Use HTTPS** + **Minimum TLS Version: 1.2**.

## 2. Thiết Lập Cloudflare WAF & Rate Limiting Chống Flood Sập Web
- Vào **Cloudflare → Security → WAF → Rate limiting rules**:
  - Tạo rule chặn các IP gửi quá **100 request / 10 giây** vào tên miền.
- Bật **Bot Fight Mode** trong **Security → Bots**.
- Nếu có dấu hiệu bị tấn công nặng, bật ngay **Under Attack Mode** trong **Overview → Quick Actions** (mất 1 click).

## 3. Khóa Origin & Bảo Vệ Cloudflare Worker (`cineverse-r2`)
- Copy toàn bộ code mới trong `upload/cloudflare-worker.js` và Deploy lại Worker.
- Vào **Worker → Settings → Variables and Secrets**, cấu hình đủ các biến Secret:
  - `ADMIN_PIN`: Mã PIN Admin bí mật (không để mặc định).
  - `OTP_SECRET`: Chuỗi ngẫu nhiên dài 32+ ký tự để ký token OTP.
  - `RESEND_API_KEY` & `RESEND_FROM`: Gửi email OTP và Key Chủ Trì bằng tên miền riêng.
  - `ALLOWED_ORIGINS`: Danh sách tên miền được phép gọi API, cách nhau bằng dấu phẩy (ví dụ: `https://cineverse.vn,https://admin.cineverse.vn,https://thodantuna-lab.github.io,capacitor://localhost,http://localhost`). Khi biến này được bật, Worker sẽ chặn CORS từ mọi tên miền giả mạo khác.
  - `SEPAY_API_TOKEN` (nếu dùng thanh toán tự động): Token đọc biến động số dư Techcombank `99999920072`.

## 4. Import Firebase Realtime Database Rules (Chống JSON Bomb)
- Mở **Firebase Console → Realtime Database → Rules**.
- Dán nội dung file `upload/firebase-database.rules.json` rồi bấm **Publish**.
- Rules này chặn ghi dữ liệu ngoài các nhánh hợp lệ (`.read: false, .write: false` ở root) và giới hạn độ dài chuỗi / số tiền đơn hàng (`<= 50.000.000đ`), chống hacker đẩy payload vài MB làm sập RTDB.
- Trong **Google Cloud Console / Firebase Console → API Key Restrictions**, giới hạn HTTP Referrers cho `apiKey` Firebase chỉ chạy trên tên miền của bạn + `localhost`.

## 5. Verify Domain Gửi Email Trên Resend (DKIM / SPF / DMARC)
- Vào **Resend → Domains → Add Domain** (nhập tên miền bạn vừa thuê).
- Thêm các bản ghi DNS `TXT` / `MX` (DKIM & SPF) vào Cloudflare DNS theo hướng dẫn của Resend.
- Sau khi Verified, cập nhật `RESEND_FROM` trong Worker thành `CineVerse <no-reply@tenmiencuaban.com>` để gửi OTP tới **mọi địa chỉ Gmail** mà không rơi vào Spam.

## 6. Bảo Vệ Tên Miền Admin Riêng Biệt
- Host Web Admin tại subdomain riêng khó đoán hoặc bật thêm **Cloudflare Zero Trust Access** (miễn phí tới 50 user) để chỉ đúng email Gmail của bạn mới mở được trang Admin ngay từ ngoài biên Cloudflare!

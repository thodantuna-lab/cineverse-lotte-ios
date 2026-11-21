import os
import sys
import time
import shlex
import mimetypes
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import boto3
    from botocore.config import Config
    from boto3.s3.transfer import TransferConfig
except ImportError:
    print("Chua co thu vien boto3. Hay chay lenh: pip install boto3")
    sys.exit(1)

ENDPOINT = "https://988ac48a415b3b62191a7c80089215f9.r2.cloudflarestorage.com"
BUCKET = "chuthuathoichien"
ACCESS_KEY_ID = "29b3b1f912c6b129be291df0d92c2805"
SECRET_ACCESS_KEY = "d030a7c93f15738e84a5f2caa6d3f8e0cc8356ac602d33ce6285ee093f84dbbc"

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".ts", ".m3u8"}
DEFAULT_MAX_WORKERS = 10
MAX_ALLOWED_WORKERS = 20


class MultiProgressTracker:
    def __init__(self, file_items):
        self._lock = threading.Lock()
        self._total_files = len(file_items)
        self._total_bytes = max(1, sum(size for _, _, size in file_items))
        self._done_files = 0
        self._failed_files = 0
        self._active = {}
        self._completed_bytes = 0
        self._last_print = 0.0
        for _, key, size in file_items:
            self._active[key] = {"seen": 0, "size": max(1, size), "finished": False}

    def make_callback(self, key, filename):
        def _cb(bytes_amount):
            with self._lock:
                entry = self._active[key]
                entry["seen"] += bytes_amount
                now = time.monotonic()
                if now - self._last_print < 0.2 and entry["seen"] < entry["size"]:
                    return
                self._last_print = now
                self._render_locked(filename if self._total_files == 1 else None)

        return _cb

    def mark_done(self, key, display_name, ok=True, error_msg=""):
        with self._lock:
            entry = self._active[key]
            if not entry["finished"]:
                entry["finished"] = True
                if ok:
                    entry["seen"] = entry["size"]
                    self._done_files += 1
                else:
                    self._failed_files += 1
            sys.stdout.write("\r" + " " * 100 + "\r")
            if ok:
                mb = entry["size"] / (1024 * 1024)
                print(f"[OK] ({self._done_files + self._failed_files}/{self._total_files}) {display_name} ({mb:.1f} MB)")
            else:
                print(f"[LOI] ({self._done_files + self._failed_files}/{self._total_files}) {display_name}: {error_msg}")
            sys.stdout.flush()

    def _render_locked(self, single_filename=None):
        total_seen = sum(v["seen"] for v in self._active.values())
        pct = min(100.0, (total_seen / self._total_bytes) * 100.0)
        mb_done = total_seen / (1024 * 1024)
        mb_total = self._total_bytes / (1024 * 1024)
        if single_filename:
            line = f"\rDang upload {single_filename}: {mb_done:.1f} / {mb_total:.1f} MB ({pct:.1f}%)"
        else:
            in_progress = sum(1 for v in self._active.values() if not v["finished"] and v["seen"] > 0)
            line = (
                f"\rTong: {mb_done:.1f} / {mb_total:.1f} MB ({pct:.1f}%) "
                f"| Xong: {self._done_files}/{self._total_files} | Dang up: {in_progress}"
            )
        sys.stdout.write(line.ljust(95))
        sys.stdout.flush()


def parse_path_line(line):
    if not line or not line.strip():
        return []
    try:
        tokens = shlex.split(line, posix=False)
    except ValueError:
        tokens = [line.strip()]
    return [t.strip().strip('"').strip("'") for t in tokens if t.strip().strip('"').strip("'")]


def expand_input_paths(raw_paths):
    collected = []
    seen = set()
    for raw in raw_paths:
        p = raw.strip().strip('"').strip("'")
        if not p:
            continue
        abs_p = os.path.abspath(p)
        if os.path.isfile(abs_p):
            if abs_p not in seen:
                seen.add(abs_p)
                collected.append(abs_p)
        elif os.path.isdir(abs_p):
            for entry in sorted(os.listdir(abs_p)):
                full = os.path.join(abs_p, entry)
                if os.path.isfile(full) and os.path.splitext(entry)[1].lower() in VIDEO_EXTS:
                    if full not in seen:
                        seen.add(full)
                        collected.append(full)
        else:
            print(f"Khong tim thay file/thu muc: {p}")
    return collected


def collect_paths_interactively():
    print("Ban co the:")
    print("  1) Keo tha 1 hoac NHIEU file video (hoac ca thu muc) vao cua so nay roi nhan Enter")
    print("  2) Hoac dan tung duong dan moi dong, nhan Enter tren dong trong de bat dau upload")
    raw_paths = []
    while True:
        prompt = "Duong dan file/thu muc: " if not raw_paths else "Them file/thu muc (Enter de bat dau): "
        line = input(prompt)
        if not line.strip():
            if raw_paths:
                break
            print("Vui long nhap it nhat 1 file hoac thu muc!")
            continue
        raw_paths.extend(parse_path_line(line))
    return raw_paths


def upload_one_file(s3, transfer_cfg, tracker, file_path, object_key):
    file_name = os.path.basename(file_path)
    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "video/mp4"
    try:
        s3.upload_file(
            file_path,
            BUCKET,
            object_key,
            ExtraArgs={"ContentType": content_type},
            Config=transfer_cfg,
            Callback=tracker.make_callback(object_key, file_name),
        )
        delete_note = ""
        try:
            os.remove(file_path)
            delete_note = "Da xoa file tren may"
        except Exception as del_exc:
            delete_note = f"Khong xoa duoc file tren may: {del_exc}"
        tracker.mark_done(object_key, f"{object_key} [{delete_note}]", ok=True)
        return True, object_key, delete_note
    except Exception as exc:
        tracker.mark_done(object_key, object_key, ok=False, error_msg=str(exc))
        return False, object_key, str(exc)


def main():
    print("=== UPLOAD NHIEU VIDEO LEN CLOUDFLARE R2 (BUCKET: chuthuathoichien) ===")
    if len(sys.argv) > 1:
        raw_paths = [arg for arg in sys.argv[1:] if arg.strip()]
    else:
        raw_paths = collect_paths_interactively()

    files = expand_input_paths(raw_paths)
    if not files:
        print("\nKhong co file video hop le nao de upload.")
        return

    print(f"\nDa chon {len(files)} file:")
    for idx, fp in enumerate(files, 1):
        size_mb = os.path.getsize(fp) / (1024 * 1024)
        print(f"  {idx}. {os.path.basename(fp)} ({size_mb:.1f} MB)")

    folder = input("\nThu muc tren R2 cho cac file nay (Enter de luu o goc): ").strip().strip("/")

    workers = 1
    if len(files) > 1:
        default_w = min(DEFAULT_MAX_WORKERS, len(files))
        raw_w = input(f"So phim upload cung luc (mac dinh {default_w}, toi da {MAX_ALLOWED_WORKERS}): ").strip()
        if raw_w.isdigit() and 1 <= int(raw_w) <= MAX_ALLOWED_WORKERS:
            workers = int(raw_w)
        else:
            workers = default_w

    file_items = []
    for fp in files:
        fname = os.path.basename(fp)
        key = f"{folder}/{fname}" if folder else fname
        file_items.append((fp, key, os.path.getsize(fp)))

    total_mb = sum(s for _, _, s in file_items) / (1024 * 1024)
    print(f"\nBat dau upload {len(file_items)} phim ({total_mb:.1f} MB) voi {workers} luong song song...\n")

    part_concurrency = 2 if workers >= 6 else 4
    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4", max_pool_connections=max(20, workers * part_concurrency + 4)),
    )

    transfer_cfg = TransferConfig(
        multipart_threshold=50 * 1024 * 1024,
        multipart_chunksize=50 * 1024 * 1024,
        max_concurrency=part_concurrency,
    )

    tracker = MultiProgressTracker(file_items)
    results = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(upload_one_file, s3, transfer_cfg, tracker, fp, key)
            for fp, key, _ in file_items
        ]
        for fut in as_completed(futures):
            results.append(fut.result())

    ok_items = [(key, note) for ok, key, note in results if ok]
    ok_count = len(ok_items)
    deleted_count = sum(1 for _, note in ok_items if note == "Da xoa file tren may")
    fail_items = [(key, err) for ok, key, err in results if not ok]

    print(f"\n=== HOAN TAT: {ok_count}/{len(results)} phim upload thanh cong (da xoa {deleted_count} file tren may) ===")
    if ok_count > 0:
        print("Worker cua web se tu dong nhan cac video moi nay.")
    if fail_items:
        print("Cac phim bi loi (file tren may van duoc giu nguyen):")
        for key, err in fail_items:
            print(f"  - {key}: {err}")


if __name__ == "__main__":
    main()

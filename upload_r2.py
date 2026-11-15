import os
import sys
import mimetypes
import threading

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


class ProgressTracker:
    def __init__(self, filename, size):
        self._filename = filename
        self._size = max(1, size)
        self._seen = 0
        self._lock = threading.Lock()

    def __call__(self, bytes_amount):
        with self._lock:
            self._seen += bytes_amount
            pct = (self._seen / self._size) * 100
            mb_done = self._seen / (1024 * 1024)
            mb_total = self._size / (1024 * 1024)
            sys.stdout.write(
                f"\rDang upload {self._filename}: {mb_done:.1f} / {mb_total:.1f} MB ({pct:.1f}%)"
            )
            sys.stdout.flush()


def main():
    print("=== UPLOAD VIDEO LEN CLOUDFLARE R2 (BUCKET: chuthuathoichien) ===")
    if len(sys.argv) > 1 and sys.argv[1].strip():
        raw_path = sys.argv[1].strip()
    else:
        raw_path = input("Keo tha file video vao day (hoac dan duong dan roi nhan Enter): ").strip()

    file_path = raw_path.strip('"').strip("'")
    if not os.path.isfile(file_path):
        print(f"\nKhong tim thay file: {file_path}")
        return

    folder = input("Thu muc tren R2 (nhan Enter de luu o goc, hoac go ten thu muc): ").strip().strip("/")
    file_name = os.path.basename(file_path)
    object_key = f"{folder}/{file_name}" if folder else file_name

    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "video/mp4"

    file_size = os.path.getsize(file_path)
    print(f"\nBat dau upload len '{BUCKET}/{object_key}' ({file_size / (1024*1024):.1f} MB)...")

    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )

    transfer_cfg = TransferConfig(
        multipart_threshold=50 * 1024 * 1024,
        multipart_chunksize=50 * 1024 * 1024,
        max_concurrency=4,
    )

    s3.upload_file(
        file_path,
        BUCKET,
        object_key,
        ExtraArgs={"ContentType": content_type},
        Config=transfer_cfg,
        Callback=ProgressTracker(file_name, file_size),
    )

    print("\n\nUpload thanh cong! Worker cua web se tu dong nhan video moi nay.")


if __name__ == "__main__":
    main()

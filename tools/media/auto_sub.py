import argparse
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def _register_cuda_dlls() -> None:
    """Add pip-installed NVIDIA CUDA/cuDNN bin directories to DLL search path on Windows."""
    if sys.platform != "win32":
        return
    venv_site = Path(sys.executable).resolve().parent.parent / "Lib" / "site-packages" / "nvidia"
    if not venv_site.exists():
        return
    extra_paths = []
    for bin_dir in venv_site.glob("*/bin"):
        if bin_dir.is_dir():
            extra_paths.append(str(bin_dir))
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(str(bin_dir))
                except OSError:
                    pass
    if extra_paths:
        os.environ["PATH"] = os.pathsep.join(extra_paths) + os.pathsep + os.environ.get("PATH", "")


def format_srt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_clock(seconds: float) -> str:
    total_s = max(0, int(seconds))
    h, rem = divmod(total_s, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def load_model(model_name: str, device_pref: str):
    from faster_whisper import WhisperModel

    if device_pref in ("auto", "cuda"):
        try:
            print(f"[Whisper] Dang tai model '{model_name}' tren GPU (CUDA float16)...")
            model = WhisperModel(model_name, device="cuda", compute_type="float16")
            print("[Whisper] Da san sang tren GPU (CUDA)!")
            return model, "cuda"
        except Exception as exc:
            if device_pref == "cuda":
                raise
            print(f"[Whisper] Khong dung duoc CUDA ({exc}), chuyen sang CPU (int8)...")

    print(f"[Whisper] Dang tai model '{model_name}' tren CPU (int8)...")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    print("[Whisper] Da san sang tren CPU!")
    return model, "cpu"


def transcribe_file(
    model,
    video_path: Path,
    language: str | None,
    task: str = "transcribe",
    output_path: Path | None = None,
) -> Path:
    if not video_path.exists():
        raise FileNotFoundError(f"Khong tim thay file: {video_path}")

    srt_path = output_path or video_path.with_suffix(".srt")
    lang_arg = None if (not language or language.lower() == "auto") else language
    mode_label = "Dich sang Tieng Anh (translate)" if task == "translate" else "Giu nguyen ngon ngu goc (transcribe)"

    print(f"\n=== Bat dau tao phu de cho: {video_path.name} ===", flush=True)
    print(f"[Che do] {mode_label} | Dang tach am thanh & loc giong noi (phim dai co the mat 30-60s)...", flush=True)
    start_ts = time.time()

    segments, info = model.transcribe(
        str(video_path),
        language=lang_arg,
        task=task,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    total_dur = info.duration or 0.0
    print(
        f"[Thong tin] Ngon ngu goc: {info.language} (do tin cay {info.language_probability:.0%}) | "
        f"Thoi luong: {format_clock(total_dur)}",
        flush=True,
    )

    lines = []
    idx = 0
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        idx += 1
        start_str = format_srt_time(seg.start)
        end_str = format_srt_time(seg.end)
        lines.append(f"{idx}\n{start_str} --> {end_str}\n{text}\n")

        if total_dur > 0:
            pct = min(100.0, (seg.end / total_dur) * 100.0)
            print(f"  [{pct:5.1f}% | {format_clock(seg.end)} / {format_clock(total_dur)}] {text}", flush=True)
        else:
            print(f"  [{format_clock(seg.end)}] {text}", flush=True)

    srt_path.write_text("\n".join(lines), encoding="utf-8")
    elapsed = time.time() - start_ts
    print(f"\n[HOAN TAT] Da tao {idx} dong phu de trong {elapsed:.1f}s -> {srt_path}", flush=True)
    return srt_path


def pick_videos_dialog() -> list[str]:
    """Open a native Windows file picker dialog to select one or more video files."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        files = filedialog.askopenfilenames(
            title="Chon file phim de tao phu de (.srt)",
            filetypes=[
                ("Video files", "*.mp4 *.mkv *.avi *.mov *.webm *.m4v *.ts *.flv"),
                ("Audio files", "*.mp3 *.wav *.m4a *.flac *.aac *.ogg"),
                ("All files", "*.*"),
            ],
        )
        root.destroy()
        return list(files)
    except Exception:
        return []


def main() -> int:
    _register_cuda_dlls()

    parser = argparse.ArgumentParser(description="Tu dong tao file phu de .srt tu video bang Faster-Whisper")
    parser.add_argument("videos", nargs="*", help="Duong dan file video (.mp4, .mkv, ...)")
    parser.add_argument("-m", "--model", default="small", help="Model Whisper (tiny, base, small, medium, large-v3-turbo)")
    parser.add_argument("-l", "--language", default="auto", help="Ma ngon ngu (vd: en, vi, hi, ja, hoac auto)")
    parser.add_argument("-t", "--task", default="transcribe", choices=["transcribe", "translate"], help="transcribe=giu ngon ngu goc, translate=dich sang Tieng Anh")
    parser.add_argument("-d", "--device", default="auto", choices=["auto", "cuda", "cpu"], help="Thiet bi chay")
    args = parser.parse_args()

    video_inputs = args.videos
    if not video_inputs:
        print("Dang mo cua so chon file video...")
        video_inputs = pick_videos_dialog()
    if not video_inputs:
        raw = input("Hoac dan duong dan file video vao day roi nhan Enter: ").strip().strip('"')
        if not raw:
            print("Khong co file nao duoc chon.")
            return 1
        video_inputs = [raw]

    model, _ = load_model(args.model, args.device)

    for raw_path in video_inputs:
        p = Path(raw_path.strip().strip('"')).expanduser()
        transcribe_file(model, p, args.language, task=args.task)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

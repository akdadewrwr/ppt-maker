"""Join screenshots into a README gif (dev only, needs Pillow): python tools/frames_to_gif.py <manifest.json> <out.gif> [width]
manifest: [{"file": "f001.png", "ms": 120}, ...]"""
import json, sys
from pathlib import Path
from PIL import Image

man = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
width = int(sys.argv[3]) if len(sys.argv) > 3 else 960
base = Path(sys.argv[1]).parent
frames = []
for f in man:
    im = Image.open(base / f["file"]).convert("RGB")
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    frames.append(im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=[f["ms"] for f in man], loop=0, optimize=True, disposal=1)
print(f"{sys.argv[2]}: {len(frames)} frames, {Path(sys.argv[2]).stat().st_size // 1024} KB")

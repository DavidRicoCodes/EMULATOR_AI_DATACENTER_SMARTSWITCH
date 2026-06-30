#!/usr/bin/env python3
"""Render and structurally verify every page of the final research PDF."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfReader


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", default="output/pdf/barc_multicast_adaptive_research_report.pdf")
    parser.add_argument("--out", default="tmp/pdfs/barc-report-qa")
    parser.add_argument(
        "--pdftoppm",
        default=r"C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe",
    )
    return parser.parse_args()


def contact_sheets(images, out_dir):
    sheets = []
    thumb_width = 300
    thumb_height = 424
    for start in range(0, len(images), 12):
        subset = images[start:start + 12]
        sheet = Image.new("RGB", (thumb_width * 4, thumb_height * 3), "white")
        draw = ImageDraw.Draw(sheet)
        for index, image_path in enumerate(subset):
            image = Image.open(image_path).convert("RGB")
            image.thumbnail((thumb_width - 10, thumb_height - 24))
            x = (index % 4) * thumb_width + 5
            y = (index // 4) * thumb_height + 18
            sheet.paste(image, (x, y))
            draw.text((x, 2 + (index // 4) * thumb_height), str(start + index + 1), fill="black")
        sheet_path = out_dir / f"contact-{start // 12 + 1:02d}.png"
        sheet.save(sheet_path)
        sheets.append(str(sheet_path))
    return sheets


def main():
    args = parse_args()
    pdf_path = Path(args.pdf)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("page-*.png"):
        old.unlink()

    subprocess.run([
        args.pdftoppm, "-png", "-r", "110", str(pdf_path), str(out_dir / "page")
    ], check=True)
    images = sorted(out_dir.glob("page-*.png"))
    reader = PdfReader(str(pdf_path))
    violations = []
    page_text_lengths = []
    with pdfplumber.open(pdf_path) as pdf:
        for index, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            page_text_lengths.append(len(text))
            if index > 0 and len(text.strip()) < 40:
                violations.append({"type": "nearly-empty-page", "page": index + 1, "characters": len(text)})
    page_count = len(reader.pages)
    if page_count < 35 or page_count > 65:
        violations.append({"type": "page-count", "expected": "35-65", "actual": page_count})
    if len(images) != page_count:
        violations.append({"type": "render-count", "expected": page_count, "actual": len(images)})
    if not reader.outline:
        violations.append({"type": "missing-bookmarks"})
    sheets = contact_sheets(images, out_dir)
    result = {
        "valid": not violations,
        "pdf": str(pdf_path.resolve()),
        "pages": page_count,
        "renderedPages": len(images),
        "textCharactersByPage": page_text_lengths,
        "contactSheets": sheets,
        "violations": violations,
        "manualVisualChecksRequired": [
            "clipping and overlap", "table readability", "chart labels",
            "headers and footers", "missing glyphs", "figure and section continuity"
        ],
    }
    (out_dir / "verification.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    if violations:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

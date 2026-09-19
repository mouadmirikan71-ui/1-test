#!/usr/bin/env python3
"""Generate clean, AI-readable PDFs from the dataset's exam.txt / correction.txt files.

Usage:
    python3 tools/txt2pdf.py            # (re)build every exam.pdf / correction.pdf
    python3 tools/txt2pdf.py 2016       # rebuild a single year

The generated PDFs are *text editions* typeset from the transcriptions:
they are searchable, printable and carry full PDF metadata (title, author,
subject with provenance URL, keywords) so an AI teacher can retrieve,
display and cite them accurately.

Fonts are vendored in tools/fonts/ (OFL-licensed DejaVu Sans + Noto Naskh
Arabic) so builds are reproducible. Arabic text is shaped with
``arabic_reshaper`` + ``python-bidi`` (pip install arabic_reshaper
python-bidi; pure-python, no system dependency).
"""
import re
import sys
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

try:
    import arabic_reshaper
    from bidi.algorithm import get_display
except ImportError:  # pragma: no cover
    arabic_reshaper = None
    get_display = None

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "dataset" / "svt" / "examens-nationaux"
FONTS = ROOT / "tools" / "fonts"

FONT_LATIN = "deja"
FONT_ARABIC = "naskh"

AR_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]")
BOLD_RE = re.compile(r"(\*\*.+?\*\*)")


def parse_txt(path: Path):
    """Split YAML front-matter from body. Returns (meta dict, body text)."""
    text = path.read_text(encoding="utf-8")
    meta, body = {}, text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            front = text[3:end].strip()
            body = text[end + 4:].strip()
            for line in front.splitlines():
                if ":" in line:
                    key, val = line.split(":", 1)
                    meta[key.strip()] = val.strip()
    return meta, body


def shape_arabic(text: str) -> str:
    """Reshape Arabic script to visual order (handles embedded Latin/digits)."""
    if arabic_reshaper is None or not AR_RE.search(text):
        return text
    return get_display(arabic_reshaper.reshape(text))


def is_rtl(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return False
    ar = sum(1 for c in letters if AR_RE.match(c))
    return ar > len(letters) / 2


def clean_cell(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    return " ".join(text.split())


class ExamPDF(FPDF):
    def __init__(self, meta, doc_label):
        super().__init__(format="A4")
        self.meta = meta
        self.doc_label = doc_label
        self.add_font(FONT_LATIN, "", FONTS / "DejaVuSans.ttf")
        self.add_font(FONT_LATIN, "B", FONTS / "DejaVuSans-Bold.ttf")
        self.add_font(FONT_ARABIC, "", FONTS / "NotoNaskhArabic-Regular.ttf")
        self.add_font(FONT_ARABIC, "B", FONTS / "NotoNaskhArabic-Bold.ttf")
        self.set_auto_page_break(True, margin=22)
        self.set_margins(18, 18, 18)

    def multi_cell(self, w, h=None, text="", **kwargs):
        # fpdf2 defaults to new_x=RIGHT, which leaves zero width for the
        # next full-width block; always return to the left margin instead.
        # (Cell positions inside tables are set explicitly, unaffected.)
        kwargs.setdefault("new_x", XPos.LMARGIN)
        kwargs.setdefault("new_y", YPos.NEXT)
        return super().multi_cell(w, h, text, **kwargs)

    # -- chrome ----------------------------------------------------------
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font(FONT_LATIN, "", 8)
        self.set_text_color(110, 110, 110)
        self.cell(0, 6, self.doc_label, align="C")
        self.ln(8)
        self.set_text_color(0, 0, 0)

    def footer(self):
        self.set_y(-16)
        self.set_font(FONT_LATIN, "", 8)
        self.set_text_color(110, 110, 110)
        src = self.meta.get("Source", "")
        if len(src) > 95:
            src = src[:94] + "…"
        self.cell(0, 5, f"Source : {src}", align="C")
        self.ln(4)
        self.cell(0, 5, f"Page {self.page_no()}/{{nb}}", align="C")

    # -- building blocks -------------------------------------------------
    def title_block(self):
        m = self.meta
        self.set_font(FONT_LATIN, "B", 17)
        self.multi_cell(0, 8, "Examen National du Baccalauréat — SVT", align="C")
        self.set_font(FONT_LATIN, "", 12)
        self.multi_cell(0, 7, f"{m.get('Sujet', '')}", align="C")
        self.set_font(FONT_LATIN, "", 10)
        self.set_text_color(80, 80, 80)
        self.multi_cell(
            0, 6,
            f"{m.get('Filière', '')}  •  Édition texte reconstituée à des fins pédagogiques",
            align="C",
        )
        self.set_text_color(0, 0, 0)
        self.ln(2)
        self.set_draw_color(30, 90, 160)
        self.set_line_width(0.8)
        self.line(18, self.get_y(), 192, self.get_y())
        self.ln(5)

    def h2(self, text):
        self.set_font(FONT_LATIN, "B", 13)
        self.set_text_color(20, 70, 140)
        self.multi_cell(0, 7, text)
        self.set_text_color(0, 0, 0)
        self.ln(1)

    def h3(self, text):
        self.set_font(FONT_LATIN, "B", 11)
        self.multi_cell(0, 6.5, text)
        self.ln(0.5)

    def para(self, text, size=10):
        if is_rtl(text):
            self.set_font(FONT_ARABIC, "", size + 1)
            self.multi_cell(0, 6, shape_arabic(text), align="R")
            self.ln(1)
            return
        # LTR paragraph with **bold** and possible short Arabic spans.
        for part in BOLD_RE.split(text):
            if not part:
                continue
            bold = part.startswith("**") and part.endswith("**") and len(part) > 4
            chunk = part[2:-2] if bold else part
            style = "B" if bold else ""
            # group consecutive Arabic chars into spans
            runs = []
            buf, buf_ar = "", None
            for ch in chunk:
                ar = bool(AR_RE.match(ch))
                if buf_ar is None:
                    buf_ar = ar
                if ar != buf_ar:
                    runs.append((buf, buf_ar))
                    buf, buf_ar = "", ar
                buf += ch
            if buf:
                runs.append((buf, buf_ar))
            for run, ar in runs:
                font = FONT_ARABIC if ar else FONT_LATIN
                self.set_font(font, style, (size + 1) if ar else size)
                self.write(5.5, shape_arabic(run) if ar else run)
            self.set_font(FONT_LATIN, "", size)
        self.ln(5.5)
        self.ln(1)

    def figure_box(self, text):
        self.set_fill_color(235, 242, 252)
        self.set_draw_color(30, 90, 160)
        self.set_font(FONT_LATIN, "", 9.5)
        self.multi_cell(0, 5.5, text, border=1, fill=True)
        self.ln(2)

    def table(self, rows):
        if not rows:
            return
        ncols = max(len(r) for r in rows)
        if ncols == 0:
            return
        usable = 174
        widths = [usable / ncols] * ncols
        # header row
        self.set_font(FONT_LATIN, "B", 9)
        self.set_fill_color(30, 90, 160)
        self.set_text_color(255, 255, 255)
        self._table_row([clean_cell(c) for c in rows[0]], widths, fill=True)
        self.set_text_color(0, 0, 0)
        self.set_font(FONT_LATIN, "", 9)
        for i, row in enumerate(rows[1:]):
            cells = [clean_cell(c) for c in row]
            cells += [""] * (ncols - len(cells))
            self.set_fill_color(244, 247, 252) if i % 2 else self.set_fill_color(255, 255, 255)
            self._table_row(cells, widths, fill=True)
        self.ln(2)

    def _table_row(self, cells, widths, fill=False):
        line_h = 5
        # compute row height
        max_lines = 1
        for cell, w in zip(cells, widths):
            lines = self.multi_cell(w, line_h, cell, dry_run=True, output="LINES")
            max_lines = max(max_lines, len(lines))
        h = max(line_h * max_lines, line_h)
        if self.get_y() + h > 275:
            self.add_page()
        x0 = self.get_x()
        y0 = self.get_y()
        for cell, w in zip(cells, widths):
            self.set_xy(x0, y0)
            self.rect(x0, y0, w, h)
            self.multi_cell(w, line_h, cell, fill=fill)
            x0 += w
        self.set_xy(18, y0 + h)


def render_body(pdf: ExamPDF, body: str):
    lines = body.splitlines()
    i = 0
    buf: list[str] = []

    def flush():
        if buf:
            pdf.para(" ".join(buf))
            buf.clear()

    while i < len(lines):
        line = lines[i].rstrip()
        s = line.strip()
        if not s:
            flush()
            i += 1
            continue
        if s.startswith("## "):
            flush()
            pdf.h2(s[3:].strip())
        elif s.startswith("### "):
            flush()
            pdf.h3(s[4:].strip())
        elif s.startswith("[Figure"):
            flush()
            pdf.figure_box(s)
        elif s.startswith("|"):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(set(c) <= set("-: ") for c in cells):
                    rows.append(cells)
                i += 1
            pdf.table(rows)
            continue
        elif re.match(r"^(\d+[\.\)]|-|•|[a-d][\.\-])\s", s) or re.match(r"^[IVX]+\.", s):
            flush()
            buf.append(s)
        elif s == "---":
            flush()
            pdf.ln(1)
        else:
            buf.append(s)
        i += 1
    flush()


def build_one(txt_path: Path, pdf_path: Path):
    meta, body = parse_txt(txt_path)
    label = f"{meta.get('Matière', 'SVT')} — {meta.get('Sujet', txt_path.stem)}"
    pdf = ExamPDF(meta, label)
    pdf.set_title(f"SVT — {meta.get('Sujet', '')}")
    pdf.set_author("Transcription pédagogique — source : AlloSchool")
    pdf.set_subject(f"{meta.get('Sujet', '')} | {meta.get('Source', '')}")
    pdf.set_keywords("SVT, bac, maroc, examen national, " + meta.get("Sujet", ""))
    pdf.alias_nb_pages("{nb}")
    pdf.add_page()
    pdf.title_block()
    render_body(pdf, body)
    pdf.output(pdf_path)
    return pdf.pages_count


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    years = [only] if only else sorted(p.name for p in BASE.iterdir() if p.is_dir())
    total = 0
    for year in years:
        for session in ("normal", "rattrapage"):
            for txt_name, pdf_name in (("exam.txt", "exam.pdf"),
                                       ("correction.txt", "correction.pdf")):
                txt = BASE / year / session / txt_name
                if not txt.exists():
                    continue
                pdf_path = BASE / year / session / pdf_name
                try:
                    n = build_one(txt, pdf_path)
                    total += 1
                    print(f"OK  {year}/{session}/{pdf_name} ({n}p)")
                except Exception as exc:  # noqa: BLE001
                    print(f"FAIL {year}/{session}/{pdf_name}: {exc}")
    print(f"Built {total} PDFs.")


if __name__ == "__main__":
    main()

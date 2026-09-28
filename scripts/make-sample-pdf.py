#!/usr/bin/env python3
"""
Generates public/books/sample-book.pdf -- a tiny, self-made study booklet.

Why hand-write a PDF? It keeps the repo free of third-party content and
licensing questions. The output is dedicated to the public domain (CC0).
Only the 14 "standard" PDF fonts are used (Helvetica), so no font files
need embedding and the file stays a few KB.

Run:  python3 scripts/make-sample-pdf.py
"""
from pathlib import Path

PAGES = [
    ("VR Study Room", ["A sample booklet for the demo.", "",
                       "Pinch (or grip) the book to move it.",
                       "Swipe or flick the stick to turn pages.", "",
                       "Made by Joey Martin. Public domain (CC0)."]),
    ("1. Algebra warm-up", ["Solve for x:", "", "  2x + 3 = 11", "  x = 4", "",
                            "Quadratic formula:", "",
                            "  x = (-b +/- sqrt(b^2 - 4ac)) / 2a"]),
    ("2. Derivatives", ["Power rule:  d/dx x^n = n x^(n-1)", "",
                        "Product rule:  (fg)' = f'g + fg'", "",
                        "Chain rule:  (f(g(x)))' = f'(g(x)) g'(x)"]),
    ("3. Integrals", ["Integral of x^n dx = x^(n+1)/(n+1) + C", "",
                      "Integral of 1/x dx = ln|x| + C", "",
                      "Fundamental theorem:",
                      "  Integral from a to b of f'(x) dx = f(b) - f(a)"]),
    ("4. Practice", ["Try these on the whiteboard (coming soon):", "",
                     "  a) d/dx (3x^2 + 5x)", "  b) Integral of 6x dx",
                     "  c) Solve x^2 - 5x + 6 = 0"]),
    ("5. Notes", ["This page is intentionally mostly blank.", "",
                  "Later milestones will let you export your", "whiteboard notes as a PDF."]),
]

W, H = 420, 595  # A5-ish portrait in PDF points (1/72 inch)

def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

def page_stream(n, title, lines):
    ops = ["BT /F2 22 Tf 36 %d Td (%s) Tj ET" % (H - 70, esc(title))]
    y = H - 120
    for line in lines:
        ops.append("BT /F1 13 Tf 36 %d Td (%s) Tj ET" % (y, esc(line)))
        y -= 22
    ops.append("BT /F1 10 Tf %d 30 Td (%d) Tj ET" % (W // 2 - 4, n))
    return "\n".join(ops).encode("latin-1")

objs = []  # list of bytes, index+1 = object number
def add(b: bytes) -> int:
    objs.append(b); return len(objs)

catalog = add(b"")  # placeholder, filled later
pages_obj = add(b"")
f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
kids = []
for i, (title, lines) in enumerate(PAGES, start=1):
    data = page_stream(i, title, lines)
    content = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
    kids.append(add(("<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] "
                     "/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>"
                     % (pages_obj, W, H, f1, f2, content)).encode()))
objs[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj
objs[pages_obj - 1] = ("<< /Type /Pages /Kids [%s] /Count %d >>"
                       % (" ".join("%d 0 R" % k for k in kids), len(kids))).encode()

out = bytearray(b"%PDF-1.4\n")
offsets = []
for i, b in enumerate(objs, start=1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + b + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, xref)

dest = Path(__file__).resolve().parent.parent / "public" / "books" / "sample-book.pdf"
dest.write_bytes(out)
print(f"wrote {dest} ({len(out)} bytes, {len(PAGES)} pages)")

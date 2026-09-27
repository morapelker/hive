# /// script
# dependencies = ["fonttools==4.62.1", "brotli==1.2.0"]
# ///
"""Outline the bundled Geist font's digits for self-contained Lottie text.

Optional authoring step: uv run apps/hive/scripts/generate-corgi-digits.py
The normal corgi generator reads the checked-in JSON, so it needs only Node.
Geist is licensed under SIL OFL; see src/renderer/src/assets/fonts/Geist-OFL.txt.
"""
import json
from pathlib import Path
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

renderer = Path(__file__).resolve().parent.parent / "src/renderer/src"
font = TTFont(renderer / "assets/fonts/Geist-Variable.woff2")
instantiateVariableFont(font, {"wght": 800}, inplace=True)
glyph_set = font.getGlyphSet()
unit = 100 / font["head"].unitsPerEm


class LottiePen(BasePen):
    def __init__(self):
        super().__init__(glyph_set)
        self.paths = []

    def point(self, point):
        return [round(point[0] * unit, 4), round(-point[1] * unit, 4)]

    def _moveTo(self, point):
        self.current = {"v": [self.point(point)], "i": [[0, 0]], "o": [[0, 0]], "c": True}

    def _lineTo(self, point):
        self.current["v"].append(self.point(point))
        self.current["i"].append([0, 0])
        self.current["o"].append([0, 0])

    def _curveToOne(self, control1, control2, end):
        control1, control2, end = map(self.point, (control1, control2, end))
        previous = self.current["v"][-1]
        self.current["o"][-1] = [round(control1[j] - previous[j], 4) for j in range(2)]
        self.current["v"].append(end)
        self.current["i"].append([round(control2[j] - end[j], 4) for j in range(2)])
        self.current["o"].append([0, 0])

    def _closePath(self):
        if self.current["v"][0] == self.current["v"][-1]:
            self.current["i"][0] = self.current["i"][-1]
            for key in ("v", "i", "o"):
                self.current[key].pop()
        self.paths.append({"ty": "sh", "ks": {"a": 0, "k": self.current}})


chars = []
for char in "0123456789":
    name = font.getBestCmap()[ord(char)]
    pen = LottiePen()
    glyph_set[name].draw(pen)
    chars.append({
        "ch": char, "size": 100, "style": "ExtraBold", "fFamily": "Geist",
        "w": round(font["hmtx"][name][0] * unit, 4),
        "data": {"shapes": [{"ty": "gr", "it": pen.paths}]}
    })
output = renderer / "pet/registry/corgi/digit-glyphs.json"
output.write_text(json.dumps({
    "source": "assets/fonts/Geist-Variable.woff2, weight 800; SIL OFL (Geist-OFL.txt)",
    "fonts": {"list": [{"fName": "Geist-ExtraBold", "fFamily": "Geist", "fStyle": "ExtraBold", "ascent": 73}]},
    "chars": chars
}, separators=(",", ":")) + "\n")
print(output)

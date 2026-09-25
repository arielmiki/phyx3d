"""Regression fixtures for the thin-wall check. Run: python3 test/fixtures/make_fixtures.py"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent

# 0.84 mm curved duct wall with pointed lightening windows cut straight through it (a drone prop
# guard): beside a window's flat side face an inward ray grazes that face, which used to read as a
# 0.1 mm wall
import math
RI, T, H = 16.5, 0.84, 10.6
h = 3.0
prof = Polygon((-h, 1.8), (h, 1.8), (h, 4.6), (0, 4.6 + h), (-h, 4.6), align=None)
win = extrude(Plane.XZ * prof, amount=4, both=True)
duct = Cylinder(RI + T, H, align=(Align.CENTER, Align.CENTER, Align.MIN)) - Cylinder(RI, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
for k in range(8):
    duct -= Rot(0, 0, 360 * (k + 0.5) / 8 - 90) * Pos(0, RI + T / 2, 0) * win
export_stl(duct, str(OUT / "duct_084.stl"), tolerance=0.02, angular_tolerance=0.2)

# a 2.4 mm lid whose rim is undercut at 45° (wider at the top): the sharp top edge tapers to nothing,
# which is an edge, not a thin wall
lid = extrude(Plane.XZ * Polygon((-18, 0), (18, 0), (20.4, 2.4), (-20.4, 2.4), align=None), amount=15, both=True)
export_stl(lid, str(OUT / "chamfered_lid.stl"), tolerance=0.02, angular_tolerance=0.2)
print("ok")

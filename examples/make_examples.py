"""Example parts made with build123d — the same way an agent would design them.
Run:  python3 examples/make_examples.py   → writes examples/*.stl
"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent

# 1. Shelf bracket (L-shape with a diagonal gusset), printed lying on its side
with BuildPart() as bracket:
    with BuildSketch(Plane.XZ) as sk:
        Polygon((0, 0), (60, 0), (60, 6), (14, 6), (6, 14), (6, 60), (0, 60), align=None)
    extrude(amount=-20)  # 20 mm wide
export_stl(bracket.part, str(OUT / "shelf_bracket.stl"))

# 2. Phone stand: base plate + leaning back support (tests stability & overhang)
with BuildPart() as stand:
    Box(80, 70, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with BuildSketch(Plane.YZ) as sk:
        Polygon((-30, 5), (-22, 5), (18, 75), (10, 75), align=None)
    extrude(amount=35, both=True)
    with Locations((0, -30, 5)):
        Box(80, 6, 12, align=(Align.CENTER, Align.CENTER, Align.MIN))  # front lip
export_stl(stand.part, str(OUT / "phone_stand.stl"))

# 3. Wall hook: plate + horizontal arm + upturned tip (big overhang if printed upright)
with BuildPart() as hook:
    Box(30, 5, 50, align=(Align.CENTER, Align.MIN, Align.MIN))
    with Locations((0, 5, 5)):
        Box(12, 35, 8, align=(Align.CENTER, Align.MIN, Align.MIN))
    with Locations((0, 34, 13)):
        Box(12, 6, 12, align=(Align.CENTER, Align.MIN, Align.MIN))
    with Locations((0, 0, 40)):
        Cylinder(2.2, 20, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
export_stl(hook.part, str(OUT / "wall_hook.stl"))

# 4. Deliberately bad: tall thin tower with a floating ledge-ish mushroom top and a 0.3 mm fin
with BuildPart() as bad:
    Cylinder(3, 70, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((0, 0, 70)):
        Cylinder(15, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((8, 0, 20)):
        Box(0.3, 10, 20, align=(Align.MIN, Align.CENTER, Align.MIN))
export_stl(bad.part, str(OUT / "bad_tower.stl"))
print("wrote", sorted(p.name for p in OUT.glob("*.stl")))

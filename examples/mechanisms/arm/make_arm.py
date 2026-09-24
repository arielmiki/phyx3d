"""2-DOF robot arm parts, modelled in assembly position (mm). Run: python3 make_arm.py"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent

# base: plate + U-bracket (concave) holding the shoulder axis at z = 60
with BuildPart() as base:
    Box(80, 80, 8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for y in (-16, 16):
        with Locations((0, y, 8)):
            Box(24, 6, 60, align=(Align.CENTER, Align.CENTER, Align.MIN))
export_stl(base.part, str(OUT / "base.stl"))

# upper arm: 100 mm long, pivots at (0,0,60), points along +X at start
with BuildPart() as upper:
    with Locations((50, 0, 60)):
        Box(112, 20, 12)
    with Locations((0, 0, 60)):
        Cylinder(4, 30, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
export_stl(upper.part, str(OUT / "upper_arm.stl"))

# forearm: pivots at the elbow (100,0,60), 80 mm long, with a gripper block at the end
with BuildPart() as fore:
    with Locations((140, 0, 60)):
        Box(88, 16, 10)
    with Locations((188, 0, 60)):
        Box(16, 30, 24)
export_stl(fore.part, str(OUT / "forearm.stl"))
print("ok")

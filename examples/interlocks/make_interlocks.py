"""Example interlocking parts, modelled in ASSEMBLED position (mm).
Run:  python3 examples/interlocks/make_interlocks.py   → writes the STLs next to this file
"""
from pathlib import Path
from build123d import *

OUT = Path(__file__).parent
CLR = 0.15   # sliding clearance per side

def export(part, name):
    export_stl(part, str(OUT / f"{name}.stl"))

# ---------------------------------------------------------------- dovetail slide (along X)
def dovetail_profile(w_top, w_bot, h, grow=0.0):
    # trapezoid in YZ: narrow at the bottom (z=0), wide at the top (z=h) -> locks against lifting
    return Polygon((-w_bot / 2 - grow, -grow), (w_bot / 2 + grow, -grow),
                   (w_top / 2 + grow, h + grow), (-w_top / 2 - grow, h + grow), align=None)

L = 60
with BuildPart() as rail:                     # base block with a dovetail groove cut from the top
    Box(L, 40, 20, align=(Align.MIN, Align.CENTER, Align.MIN))
    with BuildSketch(Plane.YZ.offset(-1)) as sk:
        with Locations((0, 12)):
            dovetail_profile(14, 20, 8.01, grow=CLR)   # groove: wide at its bottom (z=12), narrow at the top
            mirror(about=Plane.XZ)  # no-op for a symmetric shape; keeps the sketch explicit
    extrude(amount=L + 2, mode=Mode.SUBTRACT)
export(rail.part, "dovetail_rail")

with BuildPart() as slider:                   # slider: dovetail tongue + a top plate
    with BuildSketch(Plane.YZ) as sk:
        with Locations((0, 12)):
            dovetail_profile(14, 20, 8)
    extrude(amount=L)
    with Locations((L / 2, 0, 20)):
        Box(L, 30, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))
export(slider.part, "dovetail_slider")

with BuildPart() as tight:                    # same slider with no clearance: should bind
    with BuildSketch(Plane.YZ) as sk:
        with Locations((0, 12)):
            dovetail_profile(14, 20, 8, grow=CLR)
    extrude(amount=L)
    with Locations((L / 2, 0, 20 + CLR)):
        Box(L, 30, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))
export(tight.part, "dovetail_slider_tight")

# ---------------------------------------------------------------- T-slot (along X)
with BuildPart() as tslot:
    Box(L, 40, 20, align=(Align.MIN, Align.CENTER, Align.MIN))
    with Locations((L / 2, 0, 20 - 3)):       # neck
        Box(L + 2, 8 + 2 * CLR, 3.01, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((L / 2, 0, 20 - 3 - 4 - CLR)):   # head pocket
        Box(L + 2, 18 + 2 * CLR, 4 + 2 * CLR, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
export(tslot.part, "tslot_rail")
with BuildPart() as tnut:
    with Locations((L / 2, 0, 20 - 3 - 4)):
        Box(L, 18, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((L / 2, 0, 20 - 3)):
        Box(L, 8, 3 + 3, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((L / 2, 0, 20 + 3)):
        Box(L, 30, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))
export(tnut.part, "tslot_slider")

# ---------------------------------------------------------------- bayonet (push 6 mm down, twist +30° about Z)
R_IN, R_OUT, H = 15.0, 20.0, 20.0
LUG_W, LUG_H, DEPTH, TWIST = 6.0, 3.0, 6.0, 30
with BuildPart() as socket:
    Cylinder(R_OUT, H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(R_IN + CLR, H, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    for a in (0, 180):
        # vertical entry slot at angle a, from the top down to the lug's final height
        with Locations(Rot(0, 0, a) * Pos(R_IN + 2, 0, H - DEPTH - LUG_H / 2 - CLR)):
            Box(6, LUG_W + 2 * CLR, DEPTH + LUG_H + 2 * CLR + 1, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        # horizontal slot: the lug's swept path over the twist
        for k in range(0, TWIST + 1, 2):
            with Locations(Rot(0, 0, a + k) * Pos(R_IN + 2, 0, H - DEPTH - LUG_H / 2 - CLR)):
                Box(6, LUG_W + 2 * CLR, LUG_H + 2 * CLR, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
export(socket.part, "bayonet_socket")
with BuildPart() as plug:                     # plug in its assembled pose: pushed in and twisted by TWIST
    with Locations((0, 0, H - DEPTH - LUG_H / 2 - 4)):
        Cylinder(R_IN - 0.2, DEPTH + LUG_H / 2 + 4 + 8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for a in (0, 180):
        with Locations(Rot(0, 0, a + TWIST) * Pos(R_IN + 1.2, 0, H - DEPTH - LUG_H / 2)):
            Box(3.2, LUG_W, LUG_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((0, 0, H + 8)):
        Cylinder(R_OUT, 4, align=(Align.CENTER, Align.CENTER, Align.MIN))   # grip cap sitting above the socket
export(plug.part, "bayonet_plug")
print("wrote", sorted(p.name for p in OUT.glob("*.stl")))

# ---------------------------------------------------------------- dovetail + detent: 0.6 mm ridge clicks into a notch
RIDGE_H = 0.6
with BuildPart() as rail_d:
    add(rail.part)
    for y0 in (8, -15):                        # ridge on the rail top either side of the groove, not over the tongue
        with Locations((50, y0, 20)):
            Box(2, 7, RIDGE_H, align=(Align.MIN, Align.MIN, Align.MIN))
export(rail_d.part, "detent_rail")
with BuildPart() as slider_d:
    add(slider.part)
    with Locations((50 - 0.2, 0, 20)):                                      # notch in the plate's underside
        Box(2 + 0.4, 32, RIDGE_H + 0.2, align=(Align.MIN, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
export(slider_d.part, "detent_slider")
print("wrote detent pair")

# ---------------------------------------------------------------- symmetric dovetail with a grip tab at one end:
# turned 180° about Z it still slides in, so it CAN go in the wrong way round (the checker should say so)
with BuildPart() as marked:
    add(slider.part)
    with Locations((0, 0, 24)):
        Box(6, 30, 5, align=(Align.MIN, Align.CENTER, Align.MIN))
export(marked.part, "dovetail_slider_marked")
print("wrote marked slider")

# ---------------------------------------------------------------- press fit: 6.2 mm pin in a 6.0 mm hole (0.1 mm interference per side)
with BuildPart() as block:
    Box(20, 20, 12, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(3.0, 12, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
export(block.part, "pressfit_block")
with BuildPart() as pin:
    with Locations((0, 0, 2)):
        Cylinder(3.1, 16, align=(Align.CENTER, Align.CENTER, Align.MIN))
export(pin.part, "pressfit_pin")
print("wrote press-fit pair")

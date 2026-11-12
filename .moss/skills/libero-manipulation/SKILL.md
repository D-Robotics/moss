---
name: libero-manipulation
description: Manipulation primitives for LIBERO-style tabletop robot tasks — drawer opening (snap-grasp + staged pull), pick-and-place (rim-pinch for wide bowls, neck-grasp for bottles), button press, and continuous-contact pushing, all verified at 100% on libero_goal (10/10 official check_success)
when: solving tabletop manipulation tasks with a robot arm (drawers, bowls, bottles, plates, buttons), especially LIBERO-family benchmarks
---

# LIBERO manipulation primitives (verified 10/10 on libero_goal)

All patterns were discovered by Moss on the real benchmark and verified with
`env.check_success()` == True. Read with the `libero-direct` infrastructure skill
(adapter wiring, frame rule, motion API).

## Grasp patterns by object class

| Object | Pattern | Key detail |
| --- | --- | --- |
| Wide bowl (d > finger gap) | **rim-wall pinch** | fingers separate along world y; pinch a ±y rim wall that is unobstructed; fingertip pads ~1.5cm below rim top |
| Wine bottle (tall, narrow) | **neck grasp from above** | descend onto the neck; narrow grip is stable for tall carries |
| Cream cheese / small box | top-down grasp at body center | check AABB extents to size the grip |
| Drawer handle bar | **snap-grasp behind the bar** | fingers must hook behind the bar (y beyond the bar), not just touch it |
| Button | descend from above onto the button center | verify joint qpos changed |

## Drawer opening (verified t0/t3)

1. Find the slide joint (`model.jnt_type == 2`, name contains `drawer`/`cabinet` +
   `level`). Read its axis in world frame (quat2Mat of body xquat · jnt_axis).
2. Handle = drawer body position offset to the face bar. Snap-grasp: approach
   waypoint above the bar, descend, close, confirm finger gap ≈ 0.02 (touching bar
   surface) — then push past the bar so fingers hook BEHIND it before closing.
3. Pull along the slide axis in stages (0.03 → 0.06 → …). Watch `qpos` each stage;
   the drawer is open when qpos passes ~40% of its range (range like [-0.16, 0.01],
   negative = open for these scenes).

## Pick-and-place (verified t1/t2/t4/t6/t8/t9)

1. Read the object's AABB (loop `model.ngeom` where `geom_bodyid` matches — mesh
   AABBs come from per-geom local boxes, not `body_pos`).
2. Pick the unobstructed rim/side (list what else is nearby; 5cm x-clearance is
   enough). Grasp: waypoint above, descend, close, verify gripped (gap stable).
3. Lift +0.10, translate to the target site at carry height, descend until the
   object bottom is just above the target surface, open, retract.
4. Wide bowls: the plate/pan target needs x-y centering within the target radius.

## Drawer closing (verified x3, after place-inside)

After placing an object inside an open drawer: lift the arm clear, then with
the gripper CLOSED, push the drawer's front panel from its robot-side face
along -slide_axis (opposite of the opening pull). Waypoints: above the panel
face, contact on the face, sustained push until drawer qpos returns to ~0.
Budget matters: open + grasp + place can consume ~700 of the 1000-tick
horizon — keep early phases lean (coarser tolerances, fewer waypoints) so the
close push has ~250 ticks. Verify qpos ≈ 0 at the end.

## General placement rule (cavities, compartments, open containers)

Never guess a placement target from the task sentence. Walk the target body's
geom tree (the `body_aabb` pattern from t8) to find the CAVITY: the region
between the container's walls, below its rim. Place the carried object so its
bottom is BELOW the rim top (inside) and its center matches the cavity center
in x-y. A placement that rests ON the walls fails even when x-y is right.
For tall cavities (caddy compartments, drawers), descend until the object
bottom clears the wall top by the object height, then release.

## General grasp rule (match the thin axis)

Books, plates, trays: find the object's AABB, identify the THIN axis, approach
so the finger separation axis is perpendicular to it (pinch the two large
faces). Tall objects (bottles): descend onto the neck. Wide bowls: rim pinch
on the unobstructed side. When a carry works but placement fails, the grasp
is fine — fix only the target.

## Button press (verified t7)

Approach above the button, descend to contact, hold; verify the button joint qpos
moved (t7: 0 → 0.51). Success predicates need the press sustained to the end.

## Continuous-contact push (verified t5, hardest)

Closed gripper as the pusher. Approach from the side OPPOSITE the target
direction, contact the object rim, then move in small increments along the target
direction keeping contact (monitor the object's body_xpos each step). Release
contact only inside the goal region. Expect iterations: pushing is sensitive to
contact height (push at rim height, not above).

## Failure-mode debug taxonomy (ASPIRE-style: fix the mode, not the symptom)

Every retry must name the failure mode it fixes. Classify before retrying:

| Symptom | Mode | Fix |
| --- | --- | --- |
| IK fail / unreachable | frame mix or out-of-workspace | recompute in robot_base frame; check reach radius |
| gripper closes, object stays | contact geometry miss | descend lower; approach from the unobstructed side; hook behind bars |
| carry works, object drops mid-transit | grip force/surface | re-grasp at a lower point; slower waypoints |
| object placed, success False | placement on walls / wrong region | cavity rule: walk geoms, place below rim, center x-y |
| drawer qpos stuck at 0 during pull | fingers not hooked | push past the bar before closing (snap-grasp) |
| horizon exhausted (t≈1000) | step budget | coarser tolerances, fewer waypoints, merge phases |

## Solver template (proven scaffold)

introspect (bodies/joints/AABB) → phase plan with per-phase tick budget
(sum ≤ 700, reserve 300 for verification+fixes) → execute phases with prints
(phase, ticks used, key state) → env._check_success() print → screenshots.
SOLVED siblings are templates: adapt them, don't start from scratch.

## Measure before you move (verified s4)

Before writing any motion for a new task, dump the ground truth in one shot:
every body's world AND robot_base position, every joint's qpos/range, and each
body's local AABB (loop geoms by `geom_bodyid`). Two failed s4 attempts died on
a 0.15 m frame error that this dump would have caught in one line — the bowl
origin sat at base z 0.1506 while the solver assumed table level. Use the
printed numbers as the targets verbatim, and re-check intermediate waypoints
against them.

## Frame rule (the #1 failure)

Robot poses must be in robot_base frame: `p_base = p_world − body_xpos(robot0_base)`.
Sim reads are world. Mixing them makes targets look unreachable (IK fail).

## Scene geometry facts (libero_goal family)

- Robot on pedestal at world (-0.66, 0, 0.912); table top ≈ 0.9; Panda reach
  ≈ 0.855m from base; cabinet drawers slide along ±y with range [-0.16, 0.01].
- Episode horizon 1000 ticks at 20Hz — long staged motions fit.

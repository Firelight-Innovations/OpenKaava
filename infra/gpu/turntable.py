"""Turntable render (PRD 4.2 step 5, P4-2).

    blender -b --python turntable.py -- <model.glb> <out-dir> <frames> <resolution>

Imports the model, frames it, and draws <frames> evenly spaced views around it with Cycles on
the GPU, one PNG per view. Falls back to the CPU when no GPU answers, so the same script works on
the worker for a quick check.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

model, out_dir, frames, resolution = sys.argv[sys.argv.index("--") + 1 :]
frames, resolution = int(frames), int(resolution)
os.makedirs(out_dir, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=model)
scene = bpy.context.scene

# Bounds of every imported mesh, in world space, so the camera distance fits the model.
corners = [
    obj.matrix_world @ Vector(c)
    for obj in scene.objects
    if obj.type == "MESH"
    for c in obj.bound_box
]
lo = Vector(min(c[i] for c in corners) for i in range(3))
hi = Vector(max(c[i] for c in corners) for i in range(3))
center = (lo + hi) / 2
radius = max((hi - lo).length / 2, 0.01)

target = bpy.data.objects.new("target", None)
target.location = center
scene.collection.objects.link(target)

cam_data = bpy.data.cameras.new("camera")
cam_data.lens = 50
camera = bpy.data.objects.new("camera", cam_data)
scene.collection.objects.link(camera)
scene.camera = camera
track = camera.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"

sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)

world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.8, 0.8, 0.8, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
scene.world = world

scene.render.engine = "CYCLES"
scene.render.resolution_x = scene.render.resolution_y = resolution
scene.render.film_transparent = False
scene.cycles.samples = 128
scene.cycles.use_denoising = True

prefs = bpy.context.preferences.addons["cycles"].preferences
scene.cycles.device = "CPU"
for backend in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = backend
    except TypeError:
        continue
    prefs.get_devices()
    gpus = [d for d in prefs.devices if d.type == backend]
    if gpus:
        for d in prefs.devices:
            d.use = d.type == backend
        scene.cycles.device = "GPU"
        break
print(f"turntable: device={scene.cycles.device} backend={prefs.compute_device_type}")

distance = radius * 3
for i in range(frames):
    angle = 2 * math.pi * i / frames + math.radians(30)
    camera.location = center + Vector(
        (distance * math.cos(angle), distance * math.sin(angle), radius * 1.2)
    )
    scene.render.filepath = os.path.join(out_dir, f"turntable_{i:02d}.png")
    bpy.ops.render.render(write_still=True)

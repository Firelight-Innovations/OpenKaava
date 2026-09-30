# OpenKaava's headless Blender export. Run as:
#
#   blender -b <file.blend> --disable-autoexec --python-exit-code 1 --python export.py
#
# It reads its job from KAAVA_BLENDER_* environment variables (never argv, so
# there is nothing to quote), writes everything into KAAVA_BLENDER_OUT, and
# never saves the .blend. Progress goes to stdout as
#   KAAVA_PROGRESS <step>/<total> <label>
# and the final answer is <out>/result.json.
#
# Every stage is wrapped on its own: a scene with no camera-worthy geometry, or
# a Blender build without the glTF add-on, still yields whatever else worked,
# with the reason in "warnings" rather than a bare crash.

import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

OUT = os.environ["KAAVA_BLENDER_OUT"]
ENGINE = os.environ.get("KAAVA_BLENDER_ENGINE", "workbench")
RES = int(os.environ.get("KAAVA_BLENDER_RES", "512"))
VIEWS = [v for v in os.environ.get("KAAVA_BLENDER_VIEWS", "front,three-quarter,side,wire").split(",") if v]

# (id, label, azimuth degrees from -Y toward +X, elevation degrees, wireframe)
VIEW_TABLE = {
    "front": ("front", 0.0, 8.0, False),
    "three-quarter": ("three-quarter", 35.0, 22.0, False),
    "side": ("side", 90.0, 8.0, False),
    "wire": ("wire", 35.0, 22.0, True),
}

warnings = []
result = {
    "blenderVersion": ".".join(str(n) for n in bpy.app.version),
    "glb": None,
    "renders": [],
    "parts": [],
    "stats": {},
    "warnings": warnings,
}
total_steps = 2 + len([v for v in VIEWS if v in VIEW_TABLE])
step = 0


def progress(label):
    global step
    step += 1
    print("KAAVA_PROGRESS %d/%d %s" % (step, total_steps, label), flush=True)


def mesh_objects(scene):
    return [o for o in scene.objects if o.type == "MESH" and not o.hide_render]


def collect_parts(scene):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    parts = []
    for obj in scene.objects:
        entry = {
            "name": obj.name,
            "kind": obj.type.lower(),
            "parent": obj.parent.name if obj.parent else None,
            "visible": not obj.hide_render,
            "mesh": None,
            "materials": [],
            "verts": 0,
            "polys": 0,
            "tris": 0,
            "dimensions": [round(d, 4) for d in obj.dimensions],
        }
        if obj.type == "MESH":
            ev = obj.evaluated_get(depsgraph)
            mesh = ev.to_mesh()
            try:
                mesh.calc_loop_triangles()
                entry["mesh"] = obj.data.name
                entry["verts"] = len(mesh.vertices)
                entry["polys"] = len(mesh.polygons)
                entry["tris"] = len(mesh.loop_triangles)
            finally:
                ev.to_mesh_clear()
        for slot in obj.material_slots:
            if slot.material is not None and slot.material.name not in entry["materials"]:
                entry["materials"].append(slot.material.name)
        parts.append(entry)
    return parts


def scene_bounds(scene):
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    found = False
    for obj in mesh_objects(scene):
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], world[i]) for i in range(3)))
            hi = Vector((max(hi[i], world[i]) for i in range(3)))
            found = True
    if not found:
        return None
    return lo, hi


def export_glb(path):
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
        result["glb"] = os.path.basename(path)
    except Exception as exc:  # the add-on can be missing or disabled
        warnings.append("glb export failed: %s" % exc)


def pick_engine(scene, wire):
    if wire or ENGINE == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        return
    # 4.2 renamed Eevee; try the new id first, then the old.
    for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = name
            return
        except TypeError:
            continue
    scene.render.engine = "BLENDER_WORKBENCH"
    warnings.append("Eevee is unavailable in this Blender; rendered with Workbench")


def render_views(scene, bounds):
    lo, hi = bounds
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.001)

    cam_data = bpy.data.cameras.new("kaava_cam")
    cam = bpy.data.objects.new("kaava_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.lens = 50
    distance = radius / math.sin(math.atan(18.0 / 50.0)) * 1.15
    cam_data.clip_end = max(distance * 4, 100.0)

    sun = None
    if ENGINE != "workbench" and not any(o.type == "LIGHT" for o in scene.objects):
        sun_data = bpy.data.lights.new("kaava_sun", "SUN")
        sun_data.energy = 3.0
        sun = bpy.data.objects.new("kaava_sun", sun_data)
        sun.rotation_euler = (math.radians(50), 0, math.radians(30))
        scene.collection.objects.link(sun)

    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    for view_id in VIEWS:
        spec = VIEW_TABLE.get(view_id)
        if spec is None:
            warnings.append("unknown view %r skipped" % view_id)
            continue
        label, azimuth, elevation, wire = spec
        progress("render " + label)
        try:
            az, el = math.radians(azimuth), math.radians(elevation)
            offset = Vector((
                math.sin(az) * math.cos(el),
                -math.cos(az) * math.cos(el),
                math.sin(el),
            )) * distance
            cam.location = center + offset
            cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
            pick_engine(scene, wire)
            if wire:
                scene.display.shading.type = "WIREFRAME"
                scene.display.shading.show_object_outline = False
            else:
                scene.display.shading.type = "SOLID"
            filename = "%s.png" % view_id
            scene.render.filepath = os.path.join(OUT, filename)
            bpy.ops.render.render(write_still=True)
            result["renders"].append({"id": view_id, "label": label, "file": filename})
        except Exception as exc:
            warnings.append("render %s failed: %s" % (label, exc))

    if sun is not None:
        bpy.data.objects.remove(sun)
    bpy.data.objects.remove(cam)


def main():
    scene = bpy.context.scene
    os.makedirs(OUT, exist_ok=True)

    progress("parts list")
    try:
        parts = collect_parts(scene)
        result["parts"] = parts
        meshes = [p for p in parts if p["kind"] == "mesh"]
        result["stats"] = {
            "objects": len(parts),
            "meshes": len(meshes),
            "materials": len(bpy.data.materials),
            "polys": sum(p["polys"] for p in meshes),
            "tris": sum(p["tris"] for p in meshes),
        }
    except Exception as exc:
        warnings.append("parts list failed: %s" % exc)

    progress("glb")
    if mesh_objects(scene):
        export_glb(os.path.join(OUT, "model.glb"))
    else:
        warnings.append("no visible mesh objects, so there is nothing to export or render")

    bounds = scene_bounds(scene)
    if bounds is not None and VIEWS:
        render_views(scene, bounds)


try:
    main()
except Exception:
    warnings.append("export aborted: " + traceback.format_exc())
    print(traceback.format_exc(), file=sys.stderr, flush=True)
finally:
    with open(os.path.join(OUT, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh)

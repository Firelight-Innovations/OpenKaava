# Run by OpenKaava as `godot --headless --path <project> -s <this file> -- --scene <res://...> --out <file>`.
# Loads one scene without adding it to the tree (so no _ready runs and nothing
# in the game executes) and writes its node tree as JSON.
extends SceneTree

func _init() -> void:
	var scene_path := ""
	var out_path := ""
	var args := OS.get_cmdline_user_args()
	for i in range(args.size() - 1):
		if args[i] == "--scene":
			scene_path = args[i + 1]
		elif args[i] == "--out":
			out_path = args[i + 1]
	var result := {"ok": false, "scene": scene_path}
	var packed = load(scene_path)
	if packed is PackedScene:
		var root: Node = packed.instantiate()
		if root == null:
			result["error"] = "instantiate() returned null for " + scene_path
		else:
			result["nodes"] = [_walk(root, root)]
			result["ok"] = true
			root.free()
	else:
		result["error"] = "could not load " + scene_path
	var file := FileAccess.open(out_path, FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(result))
		file.close()
	quit(0 if result["ok"] else 1)

func _walk(node: Node, root: Node) -> Dictionary:
	var path := str(root.name)
	if node != root:
		path += "/" + str(root.get_path_to(node))
	var entry := {"name": str(node.name), "type": node.get_class(), "path": path, "children": []}
	var script = node.get_script()
	if script != null and script.resource_path != "":
		entry["script"] = script.resource_path
	if node != root and node.scene_file_path != "":
		entry["instance"] = node.scene_file_path
	for child in node.get_children():
		entry["children"].append(_walk(child, root))
	return entry

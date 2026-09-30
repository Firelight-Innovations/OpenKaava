# kaava-capture v1
#
# Installed by OpenKaava (Play > Enable capture) and removable from the same
# place. It does nothing unless the game was started by OpenKaava, which passes
# --kaava-dir=<folder> after `--`. It then watches that folder for `cmd.json`
# and answers with `res-<id>.json`. It never opens a socket and never touches
# the network; the whole channel is files in one temp folder.
#
# Commands: {"id": 1, "action": "capture"}, "pause", "resume".
extends Node

var _dir := ""
var _accum := 0.0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--kaava-dir="):
			_dir = arg.substr("--kaava-dir=".length())
	if _dir == "":
		set_process(false)
		return
	_write("hello.json", {"pid": OS.get_process_id(), "godot": Engine.get_version_info().get("string", "")})

func _process(delta: float) -> void:
	_accum += delta
	if _accum < 0.1:
		return
	_accum = 0.0
	var cmd_path := _dir.path_join("cmd.json")
	if not FileAccess.file_exists(cmd_path):
		return
	var text := FileAccess.get_file_as_string(cmd_path)
	DirAccess.remove_absolute(cmd_path)
	var cmd = JSON.parse_string(text)
	if typeof(cmd) != TYPE_DICTIONARY:
		return
	var id := int(cmd.get("id", 0))
	var result := {"id": id, "ok": false}
	match str(cmd.get("action", "")):
		"capture":
			result = _capture(id)
		"pause":
			get_tree().paused = true
			result["ok"] = true
		"resume":
			get_tree().paused = false
			result["ok"] = true
		_:
			result["error"] = "unknown action"
	result["time"] = Time.get_ticks_msec() / 1000.0
	var scene := get_tree().current_scene
	result["scene"] = scene.scene_file_path if scene else ""
	result["paused"] = get_tree().paused
	_write("res-%d.json" % id, result)

func _capture(id: int) -> Dictionary:
	var image := get_viewport().get_texture().get_image()
	if image == null:
		return {"id": id, "ok": false, "error": "the viewport has no image (is this a headless run?)"}
	var path := _dir.path_join("cap-%d.png" % id)
	var err := image.save_png(path)
	if err != OK:
		return {"id": id, "ok": false, "error": "save_png failed: %d" % err}
	return {"id": id, "ok": true, "png": "cap-%d.png" % id, "width": image.get_width(), "height": image.get_height()}

func _write(name: String, data: Dictionary) -> void:
	var tmp := _dir.path_join(name + ".tmp")
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(data))
	file.close()
	DirAccess.rename_absolute(tmp, _dir.path_join(name))

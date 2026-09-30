/**
 * Picks the control a setting declared and hands it what it needs.
 *
 * This is the whole reason the settings screen has no per-setting frontend code.
 * `SettingControl` is tagged on `kind`, so the switch below narrows to exactly
 * the fields that control has — and adding a setting in
 * `src-tauri/src/settings/schema.rs` needs no edit here at all. A new *kind* of
 * control does, and that is the intended cost: four shapes cover the schema, and
 * a fifth should be a decision somebody makes on purpose.
 */
import ToggleControl from "./ToggleControl";
import NumberControl from "./NumberControl";
import TextControl from "./TextControl";
import SelectControl from "./SelectControl";
import type { Setting } from "../../../bindings";
import type { SettingsSession } from "../useSettings";

export default function ControlFor({
  setting,
  session,
}: {
  setting: Setting;
  session: SettingsSession;
}) {
  const control = setting.control;

  // Re-narrowed with `typeof` below rather than cast. `valueOf` returns a
  // `SettingValue`, the union of all three shapes — it has to, since it reads a
  // map keyed by setting id — and `settings.json` is a file on disk that
  // survives upgrades, so a build that changed a setting from a number to a
  // select leaves a number sitting under a key that now wants a string. Casting
  // would put `NaN` in a field or a blank swatch on screen. Falling back to the
  // control's own default draws the setting as it ships, which is what the stale
  // value has in fact become.
  const stored = session.valueOf(setting);

  switch (control.kind) {
    case "toggle":
      return (
        <ToggleControl
          on={typeof stored === "boolean" ? stored : control.default}
          label={setting.title}
          onChange={(next) => session.set(setting, next)}
        />
      );
    case "number":
      return (
        <NumberControl
          value={typeof stored === "number" ? stored : control.default}
          min={control.min}
          max={control.max}
          step={control.step}
          unit={control.unit}
          label={setting.title}
          onChange={(next) => session.set(setting, next)}
        />
      );
    case "text":
      return (
        <TextControl
          value={typeof stored === "string" ? stored : control.default}
          placeholder={control.placeholder}
          label={setting.title}
          onChange={(next) => session.set(setting, next)}
        />
      );
    case "select":
      return (
        <SelectControl
          settingKey={setting.key}
          options={control.options}
          value={typeof stored === "string" ? stored : control.default}
          label={setting.title}
          onChange={(next) => session.set(setting, next)}
        />
      );
  }
}

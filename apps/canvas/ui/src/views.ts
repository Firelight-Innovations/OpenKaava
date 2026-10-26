/**
 * Which views the Design app offers beside the canvas itself.
 *
 * The asset list is switched off: it is to become an app of its own, and until
 * then its tab is hidden rather than deleted. `AssetList.tsx` and the
 * `canvas/assets` method are untouched. Turning this back on brings the
 * Canvas | Asset list toggle back. The tests flip it to keep covering the view.
 */
export const views = { assetList: false };

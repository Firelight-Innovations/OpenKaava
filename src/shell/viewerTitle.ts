/**
 * The file name a File Viewer's tab should read, from a path.
 *
 * Either separator is accepted, for the reason `apps/viewer/ui/src/rpc.ts`'s
 * `baseName` gives: a Windows path can contain both and the backend returns
 * whatever it was handed. A trailing separator is ignored.
 */
export function baseNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

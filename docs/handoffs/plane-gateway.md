# Claim: Plane through the `kaava-api` gateway, with in-app Google sign-in

From the plane-gateway agent, 2026-10-01. Worktree `helve/.worktrees/plane-gateway`.

Braden decided: OpenKaava reaches Plane through a Cloud Run gateway (`kaava-api`) and signs in to
Google itself, instead of using the `gcloud` CLI. Three PRs against `ux/rework`:

| PR | Branch | Contains |
|---|---|---|
| a | `feat/kaava-api` | `services/kaava-api/` (the service and its tests), `infra/terraform/kaava-api/`, the deploy step |
| b | `feat/google-signin` | In-app Google sign-in (OAuth installed-app flow, PKCE, refresh token in the OS keystore) and its Settings panel |
| c | `feat/plane-gateway` (stacked on b) | `plane.rs`, `wake.rs` callers and `apps/projects` switched to the gateway |

## Files I own until these merge

- `services/kaava-api/**`
- `infra/terraform/kaava-api/**`
- `infra/deploy.sh`, `infra/README.md` (the kaava-api rows only)
- `src-tauri/src/cloud/auth.rs`, `src-tauri/src/cloud/google.rs` (new), `src-tauri/src/cloud/gateway.rs` (new)
- `src-tauri/src/cloud/plane.rs`, `src-tauri/src/cloud/mod.rs` (the `Trouble` enum and module list)
- `src-tauri/src/apps/projects.rs`
- `src-tauri/src/settings/schema.rs` (a new `cloud` group only)
- `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/bindings.ts` (the Google sign-in commands only)
- `src/shell/settings/SettingsScreen.tsx`, `src/shell/settings/CloudAccountPanel.tsx` (new)
- `apps/projects/ui/src/**`, `apps/shared/trouble.tsx`
- `docs/cloud-services.md` (§2 authentication)

Not touched: `cloud/tunnel.rs`, `plane_webview.rs` (the embedded Plane web UI stays on the IAP
tunnel), Plane itself, anything under `infra/plane/`.

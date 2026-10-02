# kaava-api

The gateway between the OpenKaava desktop app and Plane. It is a Cloud Run service behind Google
IAM. The app sends a Google ID token, and the service reaches `plane-vm` privately over the VPC.
The Plane token (`plane-pat-kaava`) stays inside the service.

Before kaava-api, the app used the owner's `gcloud` for everything: an IAP tunnel and a hosts-file
entry for the REST API, the Plane token read from Secret Manager onto the laptop, and the Compute
API to wake the VM. Now the app needs only a Google sign-in.

```
 OpenKaava (laptop)                       Cloud Run, us-central1            kaava VPC
 ┌────────────────────┐  HTTPS + ID token ┌──────────────────────┐ Direct  ┌─────────────────┐
 │ Rust: cloud::plane │──────────────────►│ kaava-api            │ VPC     │ plane-vm :8765  │
 │ cloud::gateway     │   IAM run.invoker │  SA kaava-api        │────────►│ (Plane CE,      │
 └────────────────────┘                   │  PAT from Secret Mgr │ egress  │  unmodified)    │
                                          └──────┬───────────────┘         └─────────────────┘
                                                 │ Compute API (kaavaWaker), GCS read (records)
```

## Endpoints

| Method and path | Does |
|---|---|
| `GET /health` | 200 when the process is up. Touches nothing else |
| `GET /v1/plane/status` | `{"vm", "healthy", "detail"}`. Reads the VM state, and checks Plane's two health paths only when the VM is `RUNNING`. Never wakes anything |
| `POST /v1/plane/wake` | Starts plane-vm if it is `TERMINATED` or `STOPPED`, resumes it if `SUSPENDED`, and answers like status. It does not wait: the app polls status every 3 s (design §3.3) |
| `GET /v1/projects?profile=prod\|dev` | The project records under `gs://veistra-projects/<profile>/projects/`. A bucket read that never wakes Plane (design §3.1) |
| `GET`, `POST`, `PATCH /v1/plane/api/v1/<path>` | Plane's REST API with the service's own token |

The proxy is narrow on purpose:

- Only `GET`, `POST` and `PATCH`, and only under `/api/v1/`.
- Every path segment must be a plain name (letters, digits, `-`, `_`, `.`), the same rule as the
  app's `plane::is_safe_path`. `..`, a leading `/`, `%` escapes and anything else are refused with
  400 before Plane is called.
- `per_page` is clamped to 100.
- Calls are held to Plane's 300 a minute for the key. A short wait is slept out. A wait longer than
  5 s answers 429 with `Retry-After`. The service runs at most one instance, so the in-memory
  limiter is the whole budget.
- A body must be JSON and at most 1 MiB.

Errors the service makes itself are JSON, `{"error": <code>, "detail": <text>}`, and every reply
carries `X-Kaava-Api: 1`. A 401 or 403 **without** that header came from Cloud Run's IAM check,
which means the caller is signed out or not an invoker.

| Status and code | Means |
|---|---|
| 403 `not_allowed` | The caller passed IAM but is not in `ALLOWED_EMAILS` |
| 503 `plane_unreachable` | Plane did not answer, or its proxy answered 502 while starting. The app shows its wake button; the gateway does not wake Plane on its own |
| 502 `plane_auth` | Plane refused the service's token. Rotate `plane-pat-kaava` |
| 502 `compute`, 502 `storage` | The Compute or Storage API failed for the service account |
| 429 `rate_limited` | See above |

## Configuration

All of it is set by `infra/terraform/kaava-api`. The service reads environment variables only.

| Variable | Value |
|---|---|
| `PLANE_URL` | `http://<plane-vm internal IP>:8765`. The address, not the name, so the service does not depend on Cloud Run resolving the private `kaava.internal` zone |
| `PLANE_HOST` | `plane.kaava.internal:8765`, sent as the `Host` header, which Plane's `WEB_URL` expects |
| `PLANE_PAT` | From Secret Manager, `plane-pat-kaava`, latest version |
| `ALLOWED_EMAILS` | Comma-separated. Empty means IAM alone decides |
| `KAAVA_PROJECT`, `KAAVA_ZONE`, `PLANE_INSTANCE`, `PROJECTS_BUCKET` | `veistra-prod`, `us-central1-a`, `plane-vm`, `veistra-projects` |

Waking reuses `infra/common/kaava-wake/kaava_wake.py`: its `Instance` class for the Compute calls,
and its metadata-server token. The image copies that file in beside `kaava_api.py`.

## Deploying

Braden deploys. Nothing in this repository has run against the live project.

1. Docker Desktop must be running (the image is built locally and pushed).
2. Optional, for the in-app sign-in: create the OAuth client (below), and add its client ID to
   `oauth_client_ids` in a `infra/terraform/kaava-api/terraform.tfvars` (gitignored):
   ```hcl
   oauth_client_ids = ["1234567890-abc.apps.googleusercontent.com"]
   ```
   Until this is set, only `gcloud` ID tokens are accepted (Cloud Run accepts those for users
   without a custom audience).
3. `infra/deploy.sh plan kaava-api`, read it, then `infra/deploy.sh apply kaava-api`. Apply makes the
   Artifact Registry repository, builds and pushes the image if its tag is new, then applies the
   rest. Terraform asks before each step.
4. Copy the `url` output into OpenKaava: Settings, Cloud, Gateway URL.
5. Check it: `curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" <url>/v1/plane/status`.

The stack expects `plane/` to be applied first: it reads plane-vm's address, the `plane-pat-kaava`
secret and the `kaavaWaker` role from there.

### The OAuth client for the in-app sign-in

The desktop app signs in to Google itself (an installed-app OAuth flow with PKCE) and sends the ID
token to this service. Google issues that token with the OAuth client's ID as its audience, so the
service lists the client ID as a custom audience.

1. Google Cloud console, project `veistra-prod`: **APIs & Services → OAuth consent screen**. If no
   consent screen exists: User type **Internal** (only firelightinnovations.com accounts), app name
   `OpenKaava`, support email Braden's. Scopes: none to add; `openid` and `email` are always
   available.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**. Application type
   **Desktop app**, name `OpenKaava desktop`. Create.
3. Copy the **Client ID** and the **Client secret**. Google documents that a desktop client's secret
   is not confidential, but OpenKaava still keeps it out of `settings.json`:
   - Client ID: OpenKaava, Settings, Cloud, **Google OAuth client ID**.
   - Client secret: OpenKaava, Settings, Cloud, the Google account panel's **Client secret** field.
     It goes to Windows Credential Manager.
4. Put the client ID in `oauth_client_ids` (step 2 above) and apply again.
5. In OpenKaava, Settings, Cloud: **Sign in with Google**. The browser opens, you approve, and the
   tab says to return to OpenKaava.

## Cost

Design rule 3 asks for a written reason for every always-on resource. This stack has none.

| Resource | Basis | Monthly |
|---|---|---|
| Cloud Run `kaava-api` | Min 0 instances. CPU is billed only while a request runs (`cpu_idle`). A Plane session is a few hundred requests of under a second each; the free tier is 180,000 vCPU-seconds and 2 million requests | 0.00 |
| Direct VPC egress | No hourly charge; traffic inside one zone | 0.00 |
| Artifact Registry `kaava` | Three images kept, about 50 MB each, at 0.10 USD/GB-month | under 0.02 |
| Secret Manager access | One access per instance start, 0.03 USD per 10,000 | under 0.01 |
| **Total at the expected use** | | **about 0.02** |

What it removes: nothing billed, but the laptop no longer needs the `gcloud` CLI, a hosts entry, or
read access to `plane-pat-kaava` for the REST API.

Excluded, as the design requires: no load balancer, no NAT (the service's Google API calls leave
directly; only private ranges use the VPC), no public IP on plane-vm.

## Tests

```sh
python services/kaava-api/test_kaava_api.py
```

Unit tests for the path rule, the query clamp, the allowlist, the rate limiter, the wake decision
and the error mapping, and loopback tests that run the real HTTP server against a fake Plane on
127.0.0.1 and check that the token never reaches the reply or the log. No Google credentials and
no network beyond loopback.

Not tested without the live project: the image build (Docker), Direct VPC egress reaching
plane-vm, the firewall rule, the custom audience, and the IAM bindings.

## The embedded Plane web UI (not built)

The Projects page also shows Plane's own web UI in a child webview. That still goes through the
`gcloud` IAP tunnel and the hosts entry, and kaava-api does not change it. Moving it behind Cloud
Run is possible but is a separate decision:

- **Browser authentication.** The webview cannot attach an ID token to every request Plane's pages
  make without injecting into those pages (design rule 1 forbids it). WebView2's request
  interception covers navigations and XHR but not the WebSocket upgrade. The workable option is
  **IAP on Cloud Run** (IAP directly on the service, no load balancer): the webview signs in to
  Google once and IAP keeps a cookie. It costs nothing extra, but it needs the same OAuth consent
  screen and its own IAP access binding.
- **Plane's cookies and `WEB_URL`.** Plane has one `WEB_URL` and one CORS origin
  (`http://plane.kaava.internal:8765`), and it sets its session cookie for the host it is served
  on. Serving the UI from a `run.app` origin means changing `WEB_URL` and CORS to that origin
  (configuration, allowed), and it changes the links agents on the worker VM get, which use the
  internal name. Plane's apps (`/`, `/god-mode/`, `/spaces/`, uploads) assume they sit at the
  origin's root, so a path prefix on kaava-api would not work. It needs its own service or host.
- **The live WebSocket.** Cloud Run carries WebSockets, but this stdlib service cannot proxy them;
  it would need a stock reverse proxy (Caddy or nginx) as a second service. An open WebSocket keeps
  that instance billed for as long as Plane is on screen: about 5 USD a month at 60 hours of use
  with 1 vCPU. It also keeps plane-vm awake exactly as the tunnel does now, which is intended.

Recommendation: keep the tunnel for the webview until someone needs OpenKaava without `gcloud` at
all. Then build a second service (`plane-web`, a stock Caddy image with IAP on Cloud Run), move
`WEB_URL` to its origin, and re-run verify-first item V5 against it.

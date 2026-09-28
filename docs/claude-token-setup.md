# Setting up the Claude Code token for agent VMs

Agent VMs run Claude Code on the Claude subscription. They sign in with a long-lived OAuth token
that is kept in Secret Manager as `claude-oauth-token`, in project `veistra-prod`. The token is never
stored in the image, the repository or a file on disk. Each VM reads it when a shell starts, with
`$(gcloud secrets versions access latest ...)`, which strips a trailing `\n` but not a trailing
`\r` — so the stored value must have neither.

All commands below are Windows PowerShell 5.1, run as-is in a normal PowerShell window.

## 1. Make the token

On your own machine, with Claude Code signed in to the Firelight account:

```powershell
claude setup-token
```

A browser opens. Approve the request, and the terminal prints a token that starts with
`sk-ant-oat`. Copy it and do not paste it anywhere else.

## 2. Store it in Secret Manager

PowerShell 5.1 has no clean way to pipe a string to a native exe without appending a trailing
CRLF, and `gcloud secrets versions add --data-file=-` would store that CRLF as part of the token.
So this step reads the token straight into memory and calls the Secret Manager REST API directly
with `Invoke-RestMethod` instead of shelling out to `gcloud secrets`. The token is never written to
a file and never echoed to the screen.

```powershell
$secure = Read-Host -AsSecureString "Paste the token"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$token = $token.Trim()

$accessToken = gcloud auth print-access-token
$bytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$body = @{ payload = @{ data = [Convert]::ToBase64String($bytes) } } | ConvertTo-Json -Compress

$uri = "https://secretmanager.googleapis.com/v1/projects/veistra-prod/secrets/claude-oauth-token:addVersion"
$result = Invoke-RestMethod -Uri $uri -Method Post -Headers @{ Authorization = "Bearer $accessToken" } -ContentType "application/json" -Body $body
$result.name

Remove-Variable token, bytes, body, bstr, secure, accessToken -ErrorAction SilentlyContinue
```

`Read-Host -AsSecureString` masks the paste. `$result.name` is the only thing printed — a string
like `projects/.../secrets/claude-oauth-token/versions/7` — never the token itself. The
`Remove-Variable` line clears the plain-text copies from the session afterwards.

## 3. Check it

```powershell
gcloud compute ssh kaava-worker --zone us-central1-a --project veistra-prod ` --tunnel-through-iap -- sudo -i kaava-smoke-test
```

The first IAP SSH from a Windows machine may pop a prompt from PuTTY/plink asking whether to cache
the remote host key — answer `y`.

The `claude auth (P2-3)` line must read `ok reply ...`. You do not need to restart the VM, because
each new shell reads the latest version of the secret.

If the worker is stopped (it stops itself after 30 idle minutes), start it first:

```powershell
gcloud compute instances start kaava-worker --zone us-central1-a --project veistra-prod
```

You can confirm the stored value has no stray CR/LF without ever printing it:

```powershell
$accessToken = gcloud auth print-access-token
$uri = "https://secretmanager.googleapis.com/v1/projects/veistra-prod/secrets/claude-oauth-token/versions/latest:access"
$resp = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $accessToken" }
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($resp.payload.data))
"length=$($text.Length) prefix_ok=$($text -match '^sk-ant-oat') has_crlf=$($text -match '[\r\n]')"

Remove-Variable accessToken, resp, text
```

`prefix_ok` should be `True` and `has_crlf` should be `False`.

## Rotating or revoking

- **Rotate:** do steps 1 and 2 again. VMs use the newest version. Then disable the old version:
  `gcloud secrets versions list claude-oauth-token --project veistra-prod` and
  `gcloud secrets versions disable <n> --secret claude-oauth-token --project veistra-prod`.
- **Revoke at once:** disable every version. New shells on the VMs then have no token.

# New-machine setup for OpenKaava Cloud (PRD P1-5). Installs the three command-line tools the
# infrastructure needs, then logs in. Safe to run twice: winget skips what is already installed.
#
#   powershell -ExecutionPolicy Bypass -File infra\bootstrap.ps1

$ErrorActionPreference = "Stop"

foreach ($id in @("Google.CloudSDK", "Hashicorp.Terraform", "Hashicorp.Packer")) {
    Write-Host "== $id"
    winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
}

# winget updates PATH for new shells only; pick the tools up in this one.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")

gcloud auth login
gcloud auth application-default login
gcloud config set project veistra-prod
gcloud auth application-default set-quota-project veistra-prod

Write-Host "Ready. Next: bash infra/deploy.sh plan"

# Shared by every stack. `deploy.sh` passes this file to each one with -var-file, so a stack
# never has to be told its project twice.
#
# Nothing here is secret. The billing account ID is the one per-owner value, and it lives in the
# gitignored bootstrap/terraform.tfvars instead, because this repository is public.

project_id = "veistra-prod"
region     = "us-central1"
zone       = "us-central1-a"

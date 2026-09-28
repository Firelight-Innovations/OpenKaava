# Written by `deploy.sh migrate-bootstrap` once the state bucket existed. Before that, this stack
# kept its state locally, because it is the stack that creates the bucket.
terraform {
  backend "gcs" {
    prefix = "bootstrap"
  }
}

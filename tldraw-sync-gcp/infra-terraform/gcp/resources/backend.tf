terraform {
  backend "gcs" {
    # Bucket is passed via: terraform init -backend-config="bucket=<project-id>-tf-state"
    # Or uncomment the following line.
    # bucket = "<project-id>-tf-state"
    prefix = "terraform/projects/tldraw-sync"
  }
}

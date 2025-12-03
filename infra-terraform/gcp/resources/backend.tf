terraform {
  backend "gcs" {
    bucket = "tldraw-sync-terraform-state-bucket"
    prefix = "terraform/projects/tldraw-sync"
  }
}

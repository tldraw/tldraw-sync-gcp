terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.14.0, < 8.0.0"
    }
  }

  backend "gcs" {
    # Bucket is passed at init:
    #   terraform init -backend-config="bucket=<project-id>-tf-state"
    prefix = "terraform/projects/tldraw-sync-cloud-run"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source = "hashicorp/google"
      # Deliberately not the `>= 6.4.0, < 6.16.0` window the GKE target uses.
      # That ceiling comes from its vendored modules — infra-terraform/modules/
      # service_accounts pins `<= 6.14`, which intersected with gke_cluster's
      # `>= 6.14.0` welds the provider to exactly 6.14.0. This target uses plain
      # resources instead, so it is free of that.
      version = ">= 6.14.0, < 8.0.0"
    }
  }

  backend "gcs" {
    # Bucket is passed at init:
    #   terraform init -backend-config="bucket=<project-id>-tf-state"
    prefix = "terraform/projects/tldraw-sync-compute-engine"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

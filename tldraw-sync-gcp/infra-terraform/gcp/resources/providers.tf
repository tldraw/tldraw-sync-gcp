terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.4.0, <6.16.0"
    }
  }
}

data "google_client_config" "provider" {}

resource "google_artifact_registry_repository" "default" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  description   = "Project repository"
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
}

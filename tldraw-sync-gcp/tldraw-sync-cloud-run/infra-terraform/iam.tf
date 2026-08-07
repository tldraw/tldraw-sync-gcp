resource "google_service_account" "run" {
  account_id   = "tldraw-sync-run"
  display_name = "tldraw sync (Cloud Run)"
}

# objectAdmin, not objectViewer: the server overwrites Snapshots under rooms/ and
# creates Assets under uploads/.
resource "google_storage_bucket_iam_member" "room_data" {
  bucket = local.gcs_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.run.email}"
}

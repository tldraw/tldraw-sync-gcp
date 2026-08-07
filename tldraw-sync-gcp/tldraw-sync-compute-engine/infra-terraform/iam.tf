# Plain google_service_account + google_project_iam_member rather than the GKE
# target's vendored modules/service_accounts. That module pins the google
# provider to `<= 6.14`, which is how the whole GKE stack ends up welded to
# exactly 6.14.0.

resource "google_service_account" "app" {
  account_id   = "tldraw-sync-gce-app"
  display_name = "tldraw sync app VMs"
}

resource "google_service_account" "nginx" {
  account_id   = "tldraw-sync-gce-nginx"
  display_name = "tldraw sync routing tier VMs"
}

# The app reads and overwrites Snapshots under rooms/ and Assets under uploads/,
# so it needs create as well as read — objectAdmin, not objectViewer.
resource "google_storage_bucket_iam_member" "app_room_data" {
  bucket = local.gcs_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.app.email}"
}

resource "google_project_iam_member" "app" {
  for_each = toset([
    "roles/artifactregistry.reader", # docker pull on boot
    "roles/logging.logWriter",       # --log-driver=gcplogs
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.app.email}"
}

resource "google_project_iam_member" "nginx" {
  for_each = toset([
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nginx.email}"
}

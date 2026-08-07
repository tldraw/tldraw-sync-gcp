output "sync_url" {
  description = "Managed HTTPS out of the box, so wss:// works with no certificate to arrange. Use it as the client's VITE_API_URL."
  value       = google_cloud_run_v2_service.sync.uri
}

# For attaching another target to this substrate with create_substrate = false.
output "redis_url" {
  value     = local.redis_url
  sensitive = true
}

output "gcs_bucket_name" {
  value = local.gcs_bucket_name
}

output "network_name" {
  value = local.make ? google_compute_network.vpc[0].name : var.existing_network_name
}

output "image_repo" {
  value = "${local.artifact_registry_host}/${var.project_id}/tldraw-sync"
}

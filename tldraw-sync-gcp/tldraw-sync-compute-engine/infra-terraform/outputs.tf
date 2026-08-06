output "load_balancer_ip" {
  description = "Point your domain's A record here, then wait for the managed certificate to go ACTIVE."
  value       = google_compute_global_address.lb.address
}

output "sync_url" {
  description = "What the client's VITE_API_URL should be."
  value       = "https://${var.domain}"
}

output "app_addresses" {
  description = "Internal IPs of the app tier, in the order nginx hashes over them."
  value       = local.app_addresses
}

# These three exist so another target can attach to this substrate with
# create_substrate = false. See variables.tf.
output "redis_url" {
  value     = local.redis_url
  sensitive = true
}

output "gcs_bucket_name" {
  value = local.gcs_bucket_name
}

output "image_repo" {
  description = "Push the image here before applying."
  value       = "${local.artifact_registry_host}/${var.project_id}/tldraw-sync"
}

output "network_name" {
  value = local.network_name
}

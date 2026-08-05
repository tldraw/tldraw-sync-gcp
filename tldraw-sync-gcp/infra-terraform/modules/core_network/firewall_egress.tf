# Allow internal communication
resource "google_compute_firewall" "allow_internal" {
  project = var.project_id

  name    = "${local.common_resource_id}-allow-internal"
  network = google_compute_network.vpc_network.name

  direction = "EGRESS"

  allow {
    protocol = "all"
  }
  #all valid private ip ranges https://cloud.google.com/vpc/docs/vpc 
  # private IP ranges RFC 1918

  destination_ranges = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
  ]

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

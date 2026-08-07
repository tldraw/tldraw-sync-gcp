# Allow SSH via IAP
resource "google_compute_firewall" "allow_ssh_iap" {
  project = var.project_id
  name    = "${local.common_resource_id}-allow-ssh-iap"
  network = google_compute_network.vpc_network.name

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443"]
  }
  #IAP SOURCE RANGE https://cloud.google.com/iap/docs/using-tcp-forwarding#create-firewall-rule

  source_ranges = ["35.235.240.0/20"] # IAP ranges

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

# Allow health checks 
resource "google_compute_firewall" "allow_health_checks" {
  project = var.project_id
  name    = "${local.common_resource_id}-allow-health-checks"
  network = google_compute_network.vpc_network.name

  description = "Allow health check ingress"

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["443", "80"]
  }
  #https://cloud.google.com/load-balancing/docs/health-checks/#fw-rule
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"] # LB ranges

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
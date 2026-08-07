# Google's load balancer and health check probers come from these two ranges.
locals {
  gfe_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
}

# The load balancer reaches nginx on :80.
resource "google_compute_firewall" "lb_to_nginx" {
  name          = "tldraw-sync-gce-lb-to-nginx"
  network       = local.network_id
  direction     = "INGRESS"
  source_ranges = local.gfe_ranges
  target_tags   = ["tldraw-sync-nginx"]

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

# nginx reaches the app tier. Only nginx: the app VMs are never addressed
# directly, because going around the routing tier is going around Room Affinity.
resource "google_compute_firewall" "nginx_to_app" {
  name        = "tldraw-sync-gce-nginx-to-app"
  network     = local.network_id
  direction   = "INGRESS"
  source_tags = ["tldraw-sync-nginx"]
  target_tags = ["tldraw-sync-app"]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port)]
  }
}

# The app tier's own health check. Scoped to the prober ranges so it does not
# open the app port to the VPC at large.
resource "google_compute_firewall" "health_check_to_app" {
  name          = "tldraw-sync-gce-hc-to-app"
  network       = local.network_id
  direction     = "INGRESS"
  source_ranges = local.gfe_ranges
  target_tags   = ["tldraw-sync-app"]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.app_port)]
  }
}

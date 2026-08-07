# Global external Application Load Balancer in front of the nginx tier.
#
# Note what is NOT here: session affinity. The load balancer distributes across
# nginx VMs however it likes, because every nginx VM hashes $uri identically and
# so routes a given Room to the same app VM regardless of which nginx saw the
# request. Affinity is established one layer down, where the roomId is visible.

resource "google_compute_backend_service" "nginx" {
  name                  = "tldraw-sync-gce-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  port_name             = "http"

  # Active WebSocket connections are not held to the normal backend timeout, but
  # this governs the handshake and any non-upgraded request, and a low value here
  # is a classic way to break long-lived connections. Set it well past anything
  # a Session should need.
  timeout_sec = 86400

  # Matched to the nginx unit's `docker stop --time=30`: stop sending new
  # handshakes to a VM before it starts shutting nginx down.
  connection_draining_timeout_sec = 30

  backend {
    group           = google_compute_region_instance_group_manager.nginx.instance_group
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1.0
  }

  health_checks = [google_compute_health_check.nginx_lb.id]

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "https" {
  name            = "tldraw-sync-gce-urlmap"
  default_service = google_compute_backend_service.nginx.id
}

resource "google_compute_managed_ssl_certificate" "cert" {
  name = "tldraw-sync-gce-cert"

  managed {
    domains = [var.domain]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_target_https_proxy" "https" {
  name             = "tldraw-sync-gce-https-proxy"
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.cert.id]
}

resource "google_compute_global_address" "lb" {
  name = "tldraw-sync-gce-address"
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "tldraw-sync-gce-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.https.id
}

# Plain HTTP exists only to redirect. wss:// needs TLS, so there is no useful
# service on :80.
resource "google_compute_url_map" "redirect" {
  name = "tldraw-sync-gce-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "tldraw-sync-gce-http-proxy"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "tldraw-sync-gce-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
}

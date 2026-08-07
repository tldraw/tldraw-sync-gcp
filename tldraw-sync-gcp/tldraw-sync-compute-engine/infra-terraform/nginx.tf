# The routing tier. Stateless — any nginx VM can serve any Room, because they
# all hash the same way — so unlike the app tier this one is a managed instance
# group and gets autohealing and rolling updates for free.

locals {
  app_addresses = [
    for i in google_compute_instance.app : i.network_interface[0].network_ip
  ]

  nginx_conf = templatefile("${path.module}/templates/nginx.conf.tftpl", {
    app_addresses = local.app_addresses
    app_port      = var.app_port
    nginx_port    = 80
  })
}

resource "google_compute_instance_template" "nginx" {
  name_prefix  = "tldraw-sync-nginx-"
  machine_type = var.nginx_machine_type
  tags         = ["tldraw-sync-nginx"]

  disk {
    source_image = "projects/cos-cloud/global/images/family/cos-stable"
    auto_delete  = true
    boot         = true
    disk_size_gb = 20
    disk_type    = "pd-balanced"
  }

  network_interface {
    subnetwork = local.subnet_id
  }

  service_account {
    email  = google_service_account.nginx.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    user-data = templatefile("${path.module}/templates/nginx-cloud-init.yaml.tftpl", {
      nginx_image = var.nginx_image
      nginx_conf  = local.nginx_conf
    })
    google-logging-enabled = "true"
    block-project-ssh-keys = "true"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Without this the template cannot be replaced while the MIG references it.
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_region_instance_group_manager" "nginx" {
  name                      = "tldraw-sync-nginx-mig"
  region                    = var.region
  base_instance_name        = "tldraw-sync-nginx"
  distribution_policy_zones = var.zones
  target_size               = var.nginx_instance_count

  version {
    instance_template = google_compute_instance_template.nginx.id
  }

  named_port {
    name = "http"
    port = 80
  }

  auto_healing_policies {
    health_check = google_compute_health_check.nginx_autoheal.id
    # Boot plus docker pull. Too low and the MIG destroys instances that were
    # still starting.
    initial_delay_sec = 180
  }

  update_policy {
    type                           = "PROACTIVE"
    minimal_action                 = "REPLACE"
    most_disruptive_allowed_action = "REPLACE"
    replacement_method             = "SUBSTITUTE"
    # Surge rather than take capacity away: replacing an nginx VM drops the
    # Sessions it was proxying, and they all reconnect at once.
    max_surge_fixed       = length(var.zones)
    max_unavailable_fixed = 0
    min_ready_sec         = 30
  }

  # A change to the app tier's addresses re-renders nginx.conf, which changes the
  # instance template, which rolls this group. That is the intended chain: resize
  # the app tier and the routing tier picks it up.
  depends_on = [google_compute_instance.app]
}

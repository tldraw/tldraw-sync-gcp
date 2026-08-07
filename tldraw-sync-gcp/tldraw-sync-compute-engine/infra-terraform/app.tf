# The app tier: a fixed set of Container-Optimized OS VMs, each running the same
# image the GKE and Cloud Run targets run.
#
# WHY EXPLICIT INSTANCES RATHER THAN A MANAGED INSTANCE GROUP
#
# Consistent hashing in OSS nginx needs a static list of upstream addresses. A
# regional MIG names and addresses its instances at create time, so their IPs are
# not knowable when the nginx config is rendered — you would need a discovery
# sidecar that polls the MIG, rewrites nginx.conf and reloads. That is a bespoke
# component to write, test and explain, and it is the part most likely to be
# subtly wrong.
#
# A fixed tier of explicit instances makes the address list a plan-time value, so
# the routing tier is a rendered file with nothing to discover. The cost is real
# and worth naming: no autohealing and no rolling-update orchestration. Replacing
# a VM is `terraform taint` plus apply; resizing is editing app_instance_count.
#
# For this workload that is a smaller loss than it looks. Every change to the
# instance set reshuffles the hash ring and every Room whose hash moves pays a
# Handover, so you *want* membership changes to be deliberate rather than
# automatic. The GKE target's HPA scales on CPU, which is the wrong signal here
# anyway: idle Sessions cost almost no CPU, so you hit connection limits long
# before you hit a CPU threshold.

resource "google_compute_instance" "app" {
  count = var.app_instance_count

  name         = "tldraw-sync-app-${count.index}"
  zone         = var.zones[count.index % length(var.zones)]
  machine_type = var.app_machine_type
  tags         = ["tldraw-sync-app"]

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = local.subnet_id
    # No access_config, so no external IP. Artifact Registry and GCS go via
    # Private Google Access; /api/unfurl egresses through Cloud NAT.
  }

  service_account {
    email  = google_service_account.app.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    user-data = templatefile("${path.module}/templates/app-cloud-init.yaml.tftpl", {
      image                  = var.image
      artifact_registry_host = local.artifact_registry_host
      redis_url              = local.redis_url
      gcs_bucket_name        = local.gcs_bucket_name
      app_port               = var.app_port
    })
    google-logging-enabled = "true"
    block-project-ssh-keys = "true"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Deliberately on-demand, not Spot. A Spot preemption gives ~30 seconds and
  # arrives without warning, which makes losing a Snapshot routine — and the
  # generous shutdown budget is the main thing this target has over Cloud Run.
  scheduling {
    provisioning_model = "STANDARD"
    preemptible        = false
    automatic_restart  = true
  }

  allow_stopping_for_update = true
}

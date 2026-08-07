# The shared substrate: VPC, Memorystore, GCS bucket, Artifact Registry.
# Gated on var.create_substrate so this target can stand alone or attach to a
# substrate another target already built.

locals {
  make = var.create_substrate

  network_id = local.make ? google_compute_network.vpc[0].id : data.google_compute_network.existing[0].id

  redis_url       = local.make ? "redis://${google_redis_instance.cache[0].host}:${google_redis_instance.cache[0].port}" : var.existing_redis_url
  gcs_bucket_name = local.make ? google_storage_bucket.room_data[0].name : var.existing_gcs_bucket_name

  artifact_registry_host = "${var.region}-docker.pkg.dev"
}

resource "terraform_data" "substrate_inputs" {
  lifecycle {
    precondition {
      condition = var.create_substrate || (
        var.existing_network_name != null &&
        var.existing_redis_url != null &&
        var.existing_gcs_bucket_name != null
      )
      error_message = "With create_substrate = false you must set existing_network_name, existing_redis_url and existing_gcs_bucket_name."
    }
  }
}

resource "google_compute_network" "vpc" {
  count                   = local.make ? 1 : 0
  name                    = "tldraw-sync-run"
  auto_create_subnetworks = false
}

data "google_compute_network" "existing" {
  count = local.make ? 0 : 1
  name  = var.existing_network_name
}

# Direct VPC egress needs a subnet of its own. Cloud Run reserves IPs in blocks
# and uses roughly 2x the active instance count, so /26 is the documented
# minimum and a /24 leaves room to raise max_instances without re-planning the
# network.
resource "google_compute_subnetwork" "egress" {
  name                     = "tldraw-sync-run-egress"
  region                   = var.region
  network                  = local.network_id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_redis_instance" "cache" {
  count          = local.make ? 1 : 0
  name           = "tldraw-sync-run-redis"
  tier           = "STANDARD_HA"
  memory_size_gb = var.redis_memory_size_gb
  region         = var.region

  # Standalone, not cluster mode: roomManager.ts uses plain createClient() and a
  # global pub/sub channel. Cluster mode would need createCluster() and sharded
  # pub/sub, which is a code change rather than a config change.
  redis_version      = "REDIS_7_2"
  authorized_network = local.network_id
  connect_mode       = "DIRECT_PEERING"

  # Demo settings — see the Compute Engine target's substrate.tf for what to
  # change for production.
  auth_enabled            = false
  transit_encryption_mode = "DISABLED"

  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }
}

resource "google_storage_bucket" "room_data" {
  count                       = local.make ? 1 : 0
  name                        = "${var.project_id}-run-room-data"
  location                    = var.storage_location
  storage_class               = "STANDARD"
  force_destroy               = true
  uniform_bucket_level_access = true
}

resource "google_artifact_registry_repository" "images" {
  count         = local.make ? 1 : 0
  location      = var.region
  repository_id = "tldraw-sync"
  format        = "DOCKER"
  description   = "Container images for the tldraw sync deployment targets"
}

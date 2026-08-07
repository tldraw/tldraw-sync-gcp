# The shared substrate: VPC, Memorystore, GCS bucket, Artifact Registry.
#
# All of it is gated on var.create_substrate so this target can either stand
# alone or attach to a substrate another target already built. See the variable's
# description for why you might want to share.

locals {
  make = var.create_substrate

  network_name = local.make ? google_compute_network.vpc[0].name : var.existing_network_name
  network_id   = local.make ? google_compute_network.vpc[0].id : data.google_compute_network.existing[0].id
  subnet_id    = local.make ? google_compute_subnetwork.subnet[0].id : data.google_compute_subnetwork.existing[0].id

  redis_url       = local.make ? "redis://${google_redis_instance.cache[0].host}:${google_redis_instance.cache[0].port}" : var.existing_redis_url
  gcs_bucket_name = local.make ? google_storage_bucket.room_data[0].name : var.existing_gcs_bucket_name

  artifact_registry_host = "${var.region}-docker.pkg.dev"
}

# A `check` block would only warn. This fails the plan, which is what you want
# when the alternative is applying half a stack.
resource "terraform_data" "substrate_inputs" {
  lifecycle {
    precondition {
      condition = var.create_substrate || (
        var.existing_network_name != null &&
        var.existing_subnet_name != null &&
        var.existing_redis_url != null &&
        var.existing_gcs_bucket_name != null
      )
      error_message = "With create_substrate = false you must set existing_network_name, existing_subnet_name, existing_redis_url and existing_gcs_bucket_name."
    }
  }
}

# --- Network ----------------------------------------------------------------

resource "google_compute_network" "vpc" {
  count                   = local.make ? 1 : 0
  name                    = "tldraw-sync-gce"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  count         = local.make ? 1 : 0
  name          = "tldraw-sync-gce"
  region        = var.region
  network       = google_compute_network.vpc[0].id
  ip_cidr_range = var.subnet_cidr

  # Lets the VMs reach Artifact Registry and GCS without external IPs or NAT.
  private_ip_google_access = true
}

data "google_compute_network" "existing" {
  count = local.make ? 0 : 1
  name  = var.existing_network_name
}

data "google_compute_subnetwork" "existing" {
  count  = local.make ? 0 : 1
  name   = var.existing_subnet_name
  region = var.region
}

# Cloud NAT exists for exactly one endpoint: /api/unfurl, which fetches
# arbitrary user-supplied URLs with open-graph-scraper. Artifact Registry and
# GCS go via Private Google Access. If you don't need link previews, delete the
# router and NAT below — you remove an SSRF egress path and the NAT bill at once.
resource "google_compute_router" "nat" {
  count   = local.make ? 1 : 0
  name    = "tldraw-sync-gce-router"
  region  = var.region
  network = google_compute_network.vpc[0].id
}

resource "google_compute_router_nat" "nat" {
  count                              = local.make ? 1 : 0
  name                               = "tldraw-sync-gce-nat"
  router                             = google_compute_router.nat[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# --- Memorystore ------------------------------------------------------------

resource "google_redis_instance" "cache" {
  count          = local.make ? 1 : 0
  name           = "tldraw-sync-gce-redis"
  tier           = "STANDARD_HA"
  memory_size_gb = var.redis_memory_size_gb
  region         = var.region

  # Standalone, NOT cluster mode. roomManager.ts opens four plain createClient()
  # connections and publishes to a global `room-handover` channel; cluster mode
  # needs createCluster() and sharded pub/sub, which is a code change rather than
  # a config change. Same constraint ADR 0002 records for ElastiCache.
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.vpc[0].id
  connect_mode       = "DIRECT_PEERING"

  # Demo settings. For production set auth_enabled = true and put the AUTH
  # string in REDIS_URL (node-redis parses redis://:password@host:port), and set
  # transit_encryption_mode = "SERVER_AUTHENTICATION" and use rediss://. Both are
  # config-only for createClient(); neither needs a code change.
  auth_enabled            = false
  transit_encryption_mode = "DISABLED"

  persistence_config {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }
}

# --- Object storage ---------------------------------------------------------

resource "google_storage_bucket" "room_data" {
  count                       = local.make ? 1 : 0
  name                        = "${var.project_id}-gce-room-data"
  location                    = var.storage_location
  storage_class               = "STANDARD"
  force_destroy               = true
  uniform_bucket_level_access = true
}

# --- Image registry ---------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  count         = local.make ? 1 : 0
  location      = var.region
  repository_id = "tldraw-sync"
  format        = "DOCKER"
  description   = "Container images for the tldraw sync deployment targets"
}

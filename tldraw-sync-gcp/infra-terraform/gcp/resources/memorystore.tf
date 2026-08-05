module "tldraw-sync_redis" {
  source                  = "../../modules/memorystore"
  name                    = "tldraw-sync-redis"
  project_id              = var.project_id
  memory_size_gb          = "5"
  region                  = var.region
  location_id             = "${var.region}-b"
  alternative_location_id = "${var.region}-c"
  auth_enabled            = false
  transit_encryption_mode = "DISABLED"
  redis_version           = "REDIS_6_X"
  authorized_network      = module.network.vpc_network.id
  persistence_config = {
    persistence_mode    = "RDB"
    rdb_snapshot_period = "ONE_HOUR"
  }
}
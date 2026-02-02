module "gcs" {
    source = "../../modules/storage_bucket"
    buckets = [
        {
            bucket_name                 = "${var.project_id}-room-data"
            storage_location            = var.storage_location
            project_id                  = var.project_id
            storage_class               = "STANDARD"
            force_destroy               = true
            uniform_bucket_level_access = false
            enable_versioning           = false
            lifecycle_rule              = {
                age    =  30
                action = "Delete"
            }
        },
    ]
}

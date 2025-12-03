# compute_engine

## Summary

This module allows the user to create cloud storage buckets

--- 


## Example usage

```

module "gcs2" {
    source = "../terraform-modules/storage_bucket"

    buckets = [
    {
        bucket_name          = "test-bucket-07032024"
        storage_location      = "US"
        project_id       = "zazmic-observability-lower-002"
        storage_class    = "STANDARD"
        force_destroy = true
        uniform_bucket_level_access = false
        enable_versioning = false
    },
    {
        bucket_name          = "test-bucket-17032024"
        storage_location      = "US"
        project_id       = "zazmic-observability-lower-002"
        storage_class    = "STANDARD"
        force_destroy = true
        uniform_bucket_level_access = false
        enable_versioning = false
    },
    {
        bucket_name          = "test-bucket-27032024"
        storage_location      = "US"
        project_id       = "zazmic-observability-lower-002"
        storage_class    = "STANDARD"
        force_destroy = true
        uniform_bucket_level_access = false
        enable_versioning = false
    }
    ]

}

```
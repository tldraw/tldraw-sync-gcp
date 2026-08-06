resource "google_storage_bucket" "state_bucket" {
  for_each = { for idx, bucket in var.buckets : idx => bucket }

  project                     = each.value.project_id
  name                        = each.value.bucket_name
  location                    = each.value.storage_location
  storage_class               = each.value.storage_class
  force_destroy               = each.value.force_destroy
  uniform_bucket_level_access = each.value.uniform_bucket_level_access

  versioning {
    enabled = each.value.enable_versioning
  }

  lifecycle_rule {
    condition {
      age = each.value.lifecycle_rule.age
    }
    action {
      type = each.value.lifecycle_rule.action
    }
  }

}
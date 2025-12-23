
variable "buckets" {
  description = "List of buckets"
  default     = []
  type = list(object({
    bucket_name                 = string
    storage_location            = string
    project_id                  = string
    storage_class               = string
    enable_versioning           = bool
    force_destroy               = bool
    uniform_bucket_level_access = bool
    lifecycle_rule              = object({
      age = number
      action = string
    })
  }))
}
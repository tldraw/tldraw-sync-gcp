variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "image" {
  type        = string
  description = <<-EOT
    Full image reference, e.g.
    europe-west1-docker.pkg.dev/PROJECT/tldraw-sync/tldraw-gcp:SHA.
  EOT
}

variable "max_instances" {
  type        = number
  description = <<-EOT
    READ THE README BEFORE RAISING THIS.

    Cloud Run cannot provide Room Affinity — its session affinity is best-effort
    and keyed on the *client*, while this workload needs affinity keyed on the
    *Room*. Above one instance, a Room whose Sessions land on two instances
    livelocks: each reconnect arrives at a non-owner, forces a Handover, evicts
    everyone in the Room, and they reconnect straight back. It does not
    converge.

    One instance at concurrency 80 is a real small deployment, not a toy.
  EOT
  default     = 1

  validation {
    condition     = var.max_instances >= 1
    error_message = "max_instances must be at least 1."
  }
}

variable "concurrency" {
  type        = number
  description = <<-EOT
    Sessions per instance. Also bounds how many Rooms one instance can hold,
    which bounds the parallel GCS fan-out inside Cloud Run's fixed and
    non-configurable 10-second SIGTERM window.
  EOT
  default     = 80
}

variable "cpu" {
  type    = string
  default = "2"
}

variable "memory" {
  type    = string
  default = "1Gi"
}

variable "app_port" {
  type    = number
  default = 3001
}

# --- Substrate: create it here, or point at something that already exists ----

variable "create_substrate" {
  type        = bool
  description = <<-EOT
    When true (the default) this target provisions its own VPC, Memorystore
    instance, GCS bucket and Artifact Registry repository. Set it false and
    supply the existing_* variables to share one substrate across targets —
    Memorystore is the dominant line item, and sharing also lets you watch a
    Room hand over between deployment targets.
  EOT
  default     = true
}

variable "existing_network_name" {
  type    = string
  default = null
}

variable "existing_redis_url" {
  type    = string
  default = null
}

variable "existing_gcs_bucket_name" {
  type    = string
  default = null
}

variable "subnet_cidr" {
  type        = string
  description = "Subnet for Direct VPC egress. Must be /26 or larger; Cloud Run uses roughly 2x the active instance count in IPs."
  default     = "10.51.0.0/24"
}

variable "redis_memory_size_gb" {
  type    = number
  default = 5
}

variable "storage_location" {
  type    = string
  default = "EU"
}

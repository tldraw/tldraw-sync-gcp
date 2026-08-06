variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  description = "Region for the VMs, Memorystore and Artifact Registry."
  default     = "europe-west1"
}

variable "zones" {
  type        = list(string)
  description = "Zones the app instances are spread across, round-robin."
  default     = ["europe-west1-b", "europe-west1-c", "europe-west1-d"]
}

variable "domain" {
  type        = string
  description = <<-EOT
    Domain served by the load balancer, e.g. gce-sync.example.com. Required: a
    Google-managed certificate needs DNS validation on a domain you control, and
    wss:// needs TLS. Point an A record at the `load_balancer_ip` output, then
    wait for the certificate to go ACTIVE (can take 15-60 minutes).
  EOT
}

# --- The app tier -----------------------------------------------------------

variable "app_instance_count" {
  type        = number
  description = <<-EOT
    Number of app VMs. Fixed, not autoscaled — see README. Changing it reshuffles
    the nginx hash ring, so every Room whose hash moves pays one Handover.
  EOT
  default     = 3
}

variable "app_machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "image" {
  type        = string
  description = <<-EOT
    Full image reference to run, e.g.
    europe-west1-docker.pkg.dev/PROJECT/tldraw-sync/tldraw-gcp:SHA.
    Build and push it before applying; the VMs pull on boot.
  EOT
}

variable "app_port" {
  type    = number
  default = 3001
}

# --- The nginx tier ---------------------------------------------------------

variable "nginx_instance_count" {
  type        = number
  description = "Number of nginx VMs. Stateless — any of them can serve any Room."
  default     = 2
}

variable "nginx_machine_type" {
  type    = string
  default = "e2-small"
}

variable "nginx_image" {
  type    = string
  default = "nginx:1.27-alpine"
}

# --- Substrate: create it here, or point at something that already exists ----

variable "create_substrate" {
  type        = bool
  description = <<-EOT
    When true (the default) this target provisions its own VPC, Memorystore
    instance, GCS bucket and Artifact Registry repository, so it deploys
    end-to-end from a single apply.

    Set it false and supply the existing_* variables to share one substrate
    across several targets. Memorystore is the dominant line item, so running
    all three targets with create_substrate = true means paying for it three
    times. Sharing also lets you watch a Room hand over *between* targets: open
    the same room against two of them and the Room Lock moves a GKE pod's Room
    to a COS VM, live.
  EOT
  default     = true
}

variable "existing_network_name" {
  type        = string
  description = "VPC to attach to when create_substrate = false."
  default     = null
}

variable "existing_subnet_name" {
  type        = string
  description = "Subnet in var.region to attach to when create_substrate = false."
  default     = null
}

variable "existing_redis_url" {
  type        = string
  description = "redis://HOST:PORT of an existing Memorystore instance, reachable from the VPC above."
  default     = null
}

variable "existing_gcs_bucket_name" {
  type        = string
  description = "Existing bucket for Snapshots and Assets."
  default     = null
}

variable "subnet_cidr" {
  type    = string
  default = "10.50.0.0/20"
}

variable "redis_memory_size_gb" {
  type    = number
  default = 5
}

variable "storage_location" {
  type        = string
  description = "Location for the GCS bucket."
  default     = "EU"
}

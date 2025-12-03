
variable "project_id" {
  type        = string
  default     = ""
  description = "description"
}

variable "project_name" {
  type        = string
  default     = ""
  description = "description"
}

variable "network" {
  type        = string
  default     = ""
  description = "description"
}

variable "firewall_name" {
  type        = string
  default     = ""
  description = "description"
}

variable "common_resource_id" {
  type        = string
  default     = ""
  description = "description"
}

variable "subnets_list" {
  type = list(object({
    name      = string
    cidr      = string
    region    = optional(string)
    allow_nat = optional(bool)
    secondary_ip_range = optional(list(object({ range_name = string
      ip_cidr_range = string
    })))
  }))
  default     = []
  description = "List of subnet objects"
}
variable "folder_id" {
  type        = string
  description = "The ID of the folder where the project resides"
  default = "" 
}

variable "billing_account" {
  type        = string
  description = "The ID of the billing account to link to the project"
  default = ""
}

variable "projects_details" {
  type = list(object({
    name            = string,
    project_id      = string,
    type            = string
    folder_id       = string,
    billing_account = string,
    service_list    = optional(list(string))
  }))
  default     = []
  description = "description"
}
variable "service_list" {
  type    = list(string)
  default = ["iam.googleapis.com", "compute.googleapis.com", "cloudresourcemanager.googleapis.com"]
}
variable "service_account_address" {
  type    = string
  default = ""
}
variable "nat_external_ips" {
  type = list(object({
    name        = string
    description = string
    region      = string
  }))
  default = []
}

variable "region" {
  type = string

}

variable "firewall_rules" {
  description = "List of custom rule definitions (refer to variables file for syntax)."
  default     = []
  type        = any
}

variable "member_role_prefix" {
  type        = string
  description = "Prefix applied to iam member names."
  default     = ""
}

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
  }))
}

variable "workload_identity_service_account" {
  type = map(object({
    current_project_roles = list(string),
    k8s_namespace         = string
  }))
  default = {}
}

variable storage_location {
  type        = string
  default   = ""
}

variable "zone" {
  type        = string
  default     = ""
  description = "description"
}
variable "vm_name" {
  type        = string
  description = "description"
  default     = ""
}
variable "service_account" {
  type        = string
  description = "description"
  default     = ""
}
variable "subnetwork_project" {
  type        = string
  description = "description"
  default     = ""
}

variable "gke_workload_identity_service_account" {
  type = map(object({
    current_project_roles = list(string),
    k8s_namespace         = string
  }))
  default = {}
}

variable "project_number" {
  description = "The GCP project number of the project that will be attached to the shared VPC network"
  type        = string
  default     = ""
}

# variable "argocd_helm_chart" {
#   type = object({
#     chart      = string
#     name       = string
#     repository = string
#     namespace  = string
#     version    = string
#   })
# }

# variable "raw_helm_chart" {
#   type = object({
#     chart      = string
#     repository = string
#     version    = string
#   })
# }
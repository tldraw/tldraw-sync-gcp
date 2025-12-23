# Project
variable "project_name" {
  type = string
}

variable "project_id" {
  type = string
}

# Region
variable "region" {
  default     = "europe-west1"
  type        = string
  description = "Default region for resources"
}

# Resource Prefix
variable "common_resource_id" {
  default = null
  type    = string
}

variable "enable_shared_vpc" {
  type        = bool
  default     = false
  description = "create shared vpc"
}

# Firewalls
variable "deny_egress" {
  type        = bool
  default     = false
  description = "Deny all egress traffic"
}

# Subnets
variable "subnets" {
  type = list(object({
    name      = string
    cidr      = string
    region    = optional(string)
    allow_nat = optional(bool)
    secondary_ip_range = optional(list(object({
      range_name    = string
      ip_cidr_range = string
    })))
  }))
  default     = []
  description = "List of subnet objects"
}

# NAT 
variable "nat_source_mode" {
  type        = string
  default     = "LIST_OF_SUBNETWORKS"
  description = "NAT source IP ranges mode"
}

variable "nat_external_ips" {
  type = list(object({
    name        = string
    description = string
    region      = string
  }))
  default = []
}
# IP Ranges
variable "valid_subnet_range" {
  type    = string
  default = "192.168.0.0/16"
}
variable "global_address_name" {
  type    = string
  default = "private-ip-address"
}
variable "service_projects" {
  type = list(object({
    id   = string
    name = string
    type = string

  }))
  default = []
}

# Private Service Connect
variable "enable_private_service_connect" {
  type        = bool
  default     = true
  description = "Enable Private Service Connect"
}

variable "private_service_connect_cidr" {
  type        = string
  default     = null
  description = "CIDR range for Private Service Connect"
}

variable "psa_config" {
  description = "The Private Service Access configuration for Service Networking."
  type = object({
    ranges        = map(string)
    export_routes = optional(bool, true)
    import_routes = optional(bool, false)
  })
  default = null
}
variable "public_zones" {
  type = list(object({
    name     = string
    dns_name = string
  }))
  default = []
}

variable "private_zones" {
  type = list(object({
    name     = string
    dns_name = string
  }))
  default = []

}
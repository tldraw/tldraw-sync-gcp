module "network" {
  source                         = "../../modules/core_network"
  project_id                     = var.project_id
  project_name                   = var.project_name
  region                         = var.region
  common_resource_id             = var.common_resource_id
  subnets                        = var.subnets_list
  nat_external_ips               = var.nat_external_ips
  enable_private_service_connect = true
}


resource "google_compute_global_address" "private_ip_address" {
  project       = var.project_id
  name          = "private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = local.network
  depends_on    = [module.network]
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = local.network
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_address.name]
  depends_on              = [module.network]
}



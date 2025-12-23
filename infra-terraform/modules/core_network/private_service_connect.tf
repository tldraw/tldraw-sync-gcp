# Enable API
resource "google_project_service" "enable_service_networking_api" {
  count   = var.enable_private_service_connect ? 1 : 0
  project = var.project_id

  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}

# Reserve IP ranges
resource "google_compute_global_address" "psa_ranges" {
  for_each      = local.psa_config_ranges
  depends_on    = [google_compute_subnetwork.subnets]
  project       = var.project_id
  name          = each.key
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = split("/", each.value)[0]
  prefix_length = split("/", each.value)[1]
  network       = google_compute_network.vpc_network.id
}

# Create connection  
resource "google_service_networking_connection" "private_vpc_connection" {
  for_each = var.psa_config != null ? { 1 = 1 } : {}
  network  = google_compute_network.vpc_network.id
  service  = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [
    for k, v in google_compute_global_address.psa_ranges : v.name
  ]
}

# Export custom routes
resource "google_compute_network_peering_routes_config" "psa_routes" {
  for_each             = var.psa_config != null ? { 1 = 1 } : {}
  project              = var.project_id
  peering              = google_service_networking_connection.private_vpc_connection["1"].peering
  network              = google_compute_network.vpc_network.name
  export_custom_routes = var.psa_config.export_routes
  import_custom_routes = var.psa_config.import_routes
  depends_on           = [google_service_networking_connection.private_vpc_connection]
}
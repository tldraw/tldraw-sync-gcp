resource "google_compute_shared_vpc_host_project" "host" {
  count   = var.enable_shared_vpc ? 1 : 0
  project = var.project_id # Replace this with your host project ID in quotes
}

resource "google_compute_shared_vpc_service_project" "service" {
  for_each = { for project in var.service_projects : project.id => project
    if project.type == "service" && var.enable_shared_vpc == true
  }

  host_project    = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  service_project = each.value.id
}

resource "google_compute_network" "vpc_network" {
  name                    = "${local.common_resource_id}-vpc"
  project                 = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  auto_create_subnetworks = false
}

resource "google_compute_router" "router" {
  for_each = local.distinct_nat_regions

  project = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  name    = "${local.common_resource_id}-router-${each.value}"
  network = google_compute_network.vpc_network.self_link
  region  = each.value

  bgp {
    asn = 64514
  }
}

resource "google_compute_address" "nat_external_ip" {
  project = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  for_each = {
    for ip in local.nat_external_ips :
    ip.name => ip
  }

  name        = each.key
  description = each.value.description
  region      = each.value.region
}

resource "google_compute_router_nat" "router_nat" {
  for_each = local.dont_create_nat ? [] : local.distinct_nat_regions

  project                            = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  provider                           = google-beta
  region                             = each.value
  name                               = "${local.common_resource_id}-nat-gateway-${each.value}"
  router                             = google_compute_router.router[each.key].name
  nat_ip_allocate_option             = "MANUAL_ONLY"
  source_subnetwork_ip_ranges_to_nat = var.nat_source_mode

  nat_ips = [
    for ip in local.nat_external_ips :
    google_compute_address.nat_external_ip[ip.name].self_link
    if ip.region == each.value
  ]

  dynamic "subnetwork" {
    for_each = {
      for subnet in local.subnets_to_allow_on_nat :
      subnet.name => subnet
      if each.value == coalesce(subnet.region, var.region)
    }

    content {
      name                    = google_compute_subnetwork.subnets[subnetwork.value.name].self_link
      source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
    }
  }

  log_config {
    enable = true
    filter = "ALL"
  }
}

resource "google_compute_subnetwork" "subnets" {
  for_each = {
    for subnet in local.subnets :
    subnet.name => subnet
  }

  project                  = var.enable_shared_vpc ? google_compute_shared_vpc_host_project.host[0].project : var.project_id
  name                     = "${local.common_resource_id}-subnet-${each.value.name}"
  network                  = google_compute_network.vpc_network.name
  region                   = lookup(each.value, "region", var.region)
  private_ip_google_access = true
  # secondary_ip_range       = each.value.secondary_ip_range
  dynamic "secondary_ip_range" {
    for_each = each.value.secondary_ip_range
    content {
      range_name    = secondary_ip_range.value.range_name
      ip_cidr_range = secondary_ip_range.value.ip_cidr_range
    }
  }
  ip_cidr_range            = each.value.cidr

  log_config {
    aggregation_interval = "INTERVAL_30_SEC"
    flow_sampling        = 1
    metadata             = "INCLUDE_ALL_METADATA"
  }
}
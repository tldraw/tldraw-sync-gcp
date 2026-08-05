# terraform {
#     experiments = [module_variable_optional_attrs]
# }
locals {
  # Subnet IP ranges
  valid_subnet_range = try(var.valid_subnet_range, "192.168.0.0/16")
  network_size_step  = 20 - tonumber(split("/", local.valid_subnet_range)[1])
  psa_config_ranges  = try(var.psa_config.ranges, {})

  # Resource prefix 
  common_resource_id = coalesce(
    var.common_resource_id,
    replace(var.project_name, "_", "-")
  )

  # NAT IPs
  nat_external_ips = coalescelist(
    var.nat_external_ips,
    [{
      name        = "${local.common_resource_id}-data-ext-nat-address-1"
      description = "Permanent NAT IP, do not remove"
      region      = var.region
    }]
  )
  subnets_to_allow_on_nat = var.nat_source_mode == "LIST_OF_SUBNETWORKS" ? [
    for subnet in local.subnets :
    subnet
    if lookup(subnet, "allow_nat", false)
  ] : []
  dont_create_nat = var.nat_source_mode == "LIST_OF_SUBNETWORKS" && length(local.subnets_to_allow_on_nat) == 0

  # NAT regions 
  nat_region_list = flatten([
    for subnet in local.subnets : [
      coalesce(subnet.region, var.region)
    ] if coalesce(subnet.allow_nat, false) == true
  ])
  distinct_nat_regions = toset(distinct(local.nat_region_list))

  # Subnets
  subnets = coalescelist(
    var.subnets,
    [
      {
        name      = "public"
        cidr      = cidrsubnet(local.valid_subnet_range, local.network_size_step, 1)
        region    = var.region
        allow_nat = true
      },
      {
        name      = "private"
        cidr      = cidrsubnet(local.valid_subnet_range, local.network_size_step, 2)
        allow_nat = false
      }
    ]
  )

  # Private service connect CIDR
  psc_ip_range = coalesce(
    var.private_service_connect_cidr,
    cidrsubnet(local.valid_subnet_range, local.network_size_step, 15)
  )
}
# Get list of subnet members and roles
locals {
  subnet_member_role_list = flatten([
    for member, roles in var.member_roles : [
      for role in roles : {
        member      = member
        role        = regexall("(.*) > .* > .* > .*", role)[0][0]
        subnet_name = regexall(".* > .* > (.*) > .*", role)[0][0]
        region      = regexall(".* > .* > .* > (.*)", role)[0][0]
      }
      if length(regexall(" > subnet > ", role)) == 1
    ]
  ])
  # Create an index to use in subnet IAM resources
  indexed_subnet_member_roles = {
    for el in local.subnet_member_role_list :
    "${el.member}_${el.role}_${el.subnet_name}" => el
  }
}

# Assign subnet IAM roles
resource "google_compute_subnetwork_iam_member" "subnet-iam-member" {
  for_each = local.indexed_subnet_member_roles
  project    = var.project_id
  subnetwork = each.value.subnet_name
  region     = each.value.region
  role       = each.value.role
  member     = each.value.member

}
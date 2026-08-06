# Get list of service account members and roles
locals {
  sa_member_role_list = flatten([
    for member, roles in var.member_roles : [
      for role in roles : {
        member             = member
        role               = regexall("(.*) > .* > .*", role)[0][0]
        service_account_id = regexall(".* > .* > (.*)", role)[0][0]
      }
      if length(regexall(" > service_account > ", role)) == 1
    ]
  ])
  # Create index to use in service account IAM resources
  indexed_sa_member_roles = {
    for el in local.sa_member_role_list :
    "${el.member}_${el.role}_${el.service_account_id}" => el
  }

}

# Get service account objects
data "google_service_account" "sa" {
  for_each   = local.indexed_sa_member_roles
  account_id = replace(each.value.service_account_id, "serviceAccount:", "")
}

# Assign service account roles 
resource "google_service_account_iam_member" "member" {
  for_each = local.indexed_sa_member_roles
  service_account_id = data.google_service_account.sa[each.key].name
  role               = each.value.role
  member             = each.value.member

}
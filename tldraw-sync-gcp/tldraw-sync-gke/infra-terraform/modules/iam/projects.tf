# Get list of members and roles
locals {
  project_member_role_list = flatten([
    for member, roles in var.member_roles : [
      for role in roles : {
        member = member
        role   = role
      }
      if length(regexall(" > ", role)) == 0
    ]
  ])
  # Create index to use in IAM resource
  indexed_project_member_roles = {
    for el in local.project_member_role_list : "${el.member}_${el.role}" => el
  }
}

# Assign roles to members 
resource "google_project_iam_member" "project" {
  for_each = local.indexed_project_member_roles
  project = var.project_id
  role    = each.value.role
  member  = each.value.member
}
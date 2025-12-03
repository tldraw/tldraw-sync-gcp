locals {
  bucket_member_role_list = flatten([
    for member, roles in var.member_roles : [
      for role in roles : {
        member      = member
        role        = regexall("(.*) > .* > .*", role)[0][0]
        bucket_name = regexall(".* > .* > (.*)", role)[0][0]
      } if length(regexall(" > bucket > ", role)) == 1
    ]
  ])
  indexed_bucket_member_roles = {
    for el in local.bucket_member_role_list :
  "${el.member}_${el.role}_${el.bucket_name}" => el }
}

resource "google_storage_bucket_iam_member" "member" {
  for_each = local.indexed_bucket_member_roles
  bucket   = each.value.bucket_name
  role     = each.value.role
  member   = each.value.member
}
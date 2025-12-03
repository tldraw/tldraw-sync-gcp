resource "google_project_iam_member" "project_iam_member" {
  for_each = toset(var.project_roles)
  project  = var.project_id
  role     = each.key
  member   = "${var.prefix}:${var.service_account_address}"
}

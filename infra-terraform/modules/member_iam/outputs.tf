output "roles" {
  value       = google_project_iam_member.project_iam_member
  description = "Project roles."
}

output "project_id" {
  value       = var.project_id
  description = "Project id."
}

# Project name 
variable "project_id" {
  type = string
}

# Map of members to list of roles
variable "member_roles" {
  type = map(list(string))
  default = {}
  description = <<EOT
    A mapping of members to a list of roles to be granted on a project level. 
    The role can additionally contain a resource specification like:
    "roles/iam.serviceAccountUser > service_account > my-sa@my-project.googleapis.com"
EOT

}
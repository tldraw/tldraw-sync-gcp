variable "project_id" {
  description = ""
  default     = ""
  type        = string
}

variable "host_project" {
  description = "Enable if adding an Artifact Registry in a host project configuration (when shared with other projects)"
  default     = false
  type        = bool
}

variable "region" {
  description = "region"
  default     = ""
  type        = string
}

variable "projects_details" {
  type = list(object({
    name            = string,
    project_id      = string,
    folder_name     = string,
    billing_account = string,
    service_list    = optional(list(string)),
    type            = string
  }))
  default     = []
  description = <<EOT
    When using host_project=true, pass in the projecs_details list to grant the 
    cloudfunctions.developer role on all projects (except the host project). 
    With this you can deploy Cloud Functions or Cloud Run jobs using the common Artifact Registry SA.
  EOT
}

variable "repository_id" {
  type        = string
  description = "description"
  default     = ""
}

variable "cloud_function_sa_list" {
  type        = list(string)
  default     = []
  description = <<EOT
    When this variable is populated, the service accounts in the list will
    have the artifact registry SA added as iam.serviceAccountUser. Use this to deploy
    Cloud Functions with the registry SA (for simplicity). Example: add the 
    Google App Engine default service account for each of the projects where you will
    be deploying Cloud Functions.
  EOT
}

variable "cloud_run_sa_list" {
  type        = list(string)
  default     = []
  description = <<EOT
    When this variable is populated, the service accounts in the list will
    have the artifact registry SA added as iam.serviceAccountUser. Use this to deploy
    Cloud Run jobs with the registry SA (for simplicity). Example: add the 
    Google Compute Engine default service account for each of the projects where you will
    be deploying Cloud Run jobs.
  EOT
}

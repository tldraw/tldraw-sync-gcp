# Artifact Registry Terraform Module

This module will create an Artifact Registry repository together with a service account that will have the `roles/artifactregistry.admin` role on it. Additionally, this module can grant the necessary permissions to the Registry SA if you want to use it for other use cases, like deploying Cloud Functions and Cloud Run jobs. Also, you can use it in a host project configuration (`host_project=true`), for example, when you create a common repository to be shared by service projects, or, with a per-project configuration.

### Basic example 

Basic usage only creating the Artifact Registry repository and service account:

```tf
module "artifact-registry" {
  source = "../../modules/artifact_registry"  
  host_project           = var.project_id
  region                 = var.region
  repository_id          = var.repository_id
}
```
### Creating repositories in separate projects with Cloud Run bindings for the Artifact Registry SA

Use this approach, for example, when you need to create multiple Artifact Registries instead of a common one. Just provide the service accounts used by Cloud Run (commonly the default Compute Engine SA) or Cloud Functions (commonly the default App Engine SA) so that the module can attach the corresponding bindings to the Artifact Registry SA of each project.

```tf
module "artifact-registry" {
  source                 = "../modules/artifact_registry"
  project_id             = var.project_id
  region                 = var.region
  repository_id          = var.repository_id
  cloud_run_sa_list      = [
    "example-compute-engine-sa@developer.gserviceaccount.com"
  ]
  cloud_function_sa_list = [
    "example-app-engine-sa@appspot.gserviceaccount.com"
  ]
}
```

### Creating a single repository when using a host project

When using the approach of having a single Artifact Registry in a host/common project, you can use `host_project=true` and provide the `projects_details` variable with the `services` type projects (see the `projects_details` variable in `foundation/terraform.tfvars`). Like in the previous scenario, provide the necessary service accounts so that the module can create the corresponding bindings to the common Artifact Registry SA.

```tf
module "artifact-registry" {
  source                 = "../modules/artifact_registry"
  project_id             = var.project_id
  region                 = var.region
  repository_id          = var.repository_id
  host_project           = true
  projects_details       = var.projects_details
  cloud_function_sa_list = [
    "prod-example-app-engine-sa@appspot.gserviceaccount.com",
    "dev-example-app-engine-sa@appspot.gserviceaccount.com"
  ]
  cloud_run_sa_list      = [
    "prod-example-compute-engine-sa@developer.gserviceaccount.com",
    "dev-example-compute-engine-sa@developer.gserviceaccount.com" 
  ]
}
```
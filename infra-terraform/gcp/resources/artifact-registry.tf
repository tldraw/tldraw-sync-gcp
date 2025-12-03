module "tldraw-sync_artifact" {
  source                  = "../../modules/artifact_registry"
  repository_id           = "tldraw-sync"
  project_id              = var.project_id
  region                  = var.region
}
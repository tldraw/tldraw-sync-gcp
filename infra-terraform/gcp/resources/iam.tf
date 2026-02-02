module "gke_sa" {
  source = "../../modules/service_accounts"

  project_id = var.project_id
  names      = ["tf-gke"]
  prefix     = "sa"
  project_roles = [
    "${var.project_id}=>roles/artifactregistry.reader",
    "${var.project_id}=>roles/container.defaultNodeServiceAccount"
  ]
}

module "service-accounts" {
  source = "../../modules/service_accounts"
  depends_on = [
    module.gke
  ]
  for_each              = var.gke_workload_identity_service_account
  project_id            = var.project_id
  names                 = ["${each.key}"]
  current_project_roles = lookup(each.value, "current_project_roles", [])
  # authoritative roles granted *on* the service accounts to other identities
  iam = {
    "roles/iam.workloadIdentityUser" = ["serviceAccount:${var.project_id}.svc.id.goog[${each.value["k8s_namespace"]}/${each.key}]"]
    "roles/iam.serviceAccountTokenCreator" = ["serviceAccount:tldraw-sync-sa@${var.project_id}.iam.gserviceaccount.com"]
  }
}
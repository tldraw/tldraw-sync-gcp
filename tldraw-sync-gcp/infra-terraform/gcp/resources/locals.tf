locals {
  network        = "projects/${var.project_id}/global/networks/${var.common_resource_id}-vpc"
  gke_subnetwork = "${var.common_resource_id}-subnet-public-subnet"
}

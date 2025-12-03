module "gke" {
  source                     = "../../modules/gke_cluster"
  project_id                 = var.project_id
  name                       = "tldraw-sync-cluster"
  region                     = var.region
  regional                   = true
  zones                      = ["europe-west1-b","europe-west1-c"]
  network                    = "${var.common_resource_id}-vpc"
  subnetwork                 = "${var.common_resource_id}-subnet-public-subnet"
  ip_range_pods              = "public-subnet-secondary-range"
  ip_range_services          = "public-subnet-secondary-range-2"
  master_ipv4_cidr_block     = "10.217.0.0/28"
  enable_private_endpoint    = true
  deploy_using_private_endpoint = true
  http_load_balancing        = false
  network_policy             = false
  horizontal_pod_autoscaling = true
  filestore_csi_driver       = false
  deletion_protection        = false
  remove_default_node_pool   = true
  master_authorized_networks = [
    {
      cidr_block   = "10.40.0.0/16",
      display_name = "subnet-cidr"
    }
  ]

  node_pools = [
    {
      name            = "default-pool"
      machine_type    = "e2-medium"
      min_count       = 1
      max_count       = 20
      local_ssd_count = 0
      spot            = false
      disk_size_gb    = 50
      disk_type       = "pd-ssd"
      image_type      = "COS_CONTAINERD"
      enable_gcfs     = false
      enable_gvnic    = false
      logging_variant = "DEFAULT"
      auto_repair     = true
      auto_upgrade    = true
      service_account = module.gke_sa.email
      preemptible     = false
    }
  ]

  node_pools_oauth_scopes = {
    all = [
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring",
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/compute",
      "https://www.googleapis.com/auth/cloud-platform"
    ]
  }

  

  node_pools_resource_labels = {
    "default-pool" = {
      "goog-gke-node-pool-provisioning-model" = "on-demand"
    }

  }
}

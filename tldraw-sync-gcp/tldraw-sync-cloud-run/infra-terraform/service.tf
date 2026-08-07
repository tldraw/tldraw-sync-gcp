resource "google_cloud_run_v2_service" "sync" {
  name                = "tldraw-sync"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.run.email

    # Best-effort and keyed on the CLIENT, not the Room. It keeps one browser's
    # reconnects on one instance, which is worth having, but it is NOT Room
    # Affinity and does not make max_instances > 1 safe. See the README.
    session_affinity = true

    max_instance_request_concurrency = var.concurrency

    # The platform maximum. Every Session is force-closed at least hourly and
    # the client reconnects; harmless at one instance, because the reconnect
    # returns to the only instance, which still owns the Room.
    timeout = "3600s"

    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = 1
      max_instance_count = var.max_instances
    }

    vpc_access {
      # PRIVATE_RANGES_ONLY: Memorystore over the VPC, /api/unfurl straight out
      # to the internet through Cloud Run's own egress. ALL_TRAFFIC would force
      # everything through Cloud NAT, which is what triggers Google's documented
      # 30s+ cold start.
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = local.network_id
        subnetwork = google_compute_subnetwork.egress.id
      }
    }

    containers {
      image = var.image

      # Cloud Run injects PORT from container_port. PORT is a reserved variable
      # and must not appear in an env block; src/index.ts reads it either way.
      ports {
        container_port = var.app_port
      }

      env {
        name  = "REDIS_URL"
        value = local.redis_url
      }

      env {
        name  = "GCS_BUCKET_NAME"
        value = local.gcs_bucket_name
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # Cloud Run exposes no per-instance identity. roomManager.ts appends a
      # random UUID so Owner Identity is unique regardless; this only makes the
      # logs say which revision a Room Owner belongs to.
      env {
        name  = "HOSTNAME"
        value = "cloudrun"
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }

        # CPU always allocated. Not optional, and the usual justification (the
        # 5s lock heartbeat needs CPU) is the weaker one — an instance with an
        # open WebSocket is already serving a request and already has CPU.
        #
        # The real reason is releaseRoom(): the outgoing owner has dropped the
        # Room and is awaiting a handover-ready signal with no socket of its
        # own open. Throttled CPU in that window stalls past the 10-second lock
        # lease and triggers a spurious lock loss — and renewRoomLock drops the
        # Room WITHOUT saving on lock loss. That is the one path in this system
        # that actually loses data.
        #
        # min_instance_count >= 1 requires this anyway.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        tcp_socket {
          port = var.app_port
        }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 10
      }

      # No liveness probe. /api/health returns 200 unconditionally and checks
      # neither Redis nor GCS, so it can only detect a dead process — which
      # Cloud Run already detects. A probe here would add nothing but a false
      # sense of coverage.
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = google_cloud_run_v2_service.sync.location
  name     = google_cloud_run_v2_service.sync.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Two health checks, deliberately dumb and deliberately tuned differently.
#
# /api/health returns a static 200 and checks nothing — not Redis, not GCS. That
# is a real blind spot: if Redis fails *after* startup, renewRoomLock swallows
# the error, every WebSocket upgrade starts failing, and /api/health keeps
# saying "ok". A VM that cannot admit a single new Session looks perfectly
# healthy.
#
# Keeping the dumb check anyway is a considered choice, not laziness:
#
#   - Redis is a SHARED dependency. A Redis-aware autohealing check turns a
#     60-second Memorystore blip into a simultaneous rebuild of the whole fleet.
#     Every VM fails at the same instant, every VM gets destroyed, and now you
#     have a cold fleet *and* a Redis problem.
#   - A Redis-aware load balancer check is barely better: when every backend is
#     unhealthy the load balancer 502s everyone. That converts "new Sessions
#     fail, existing ones keep working" into "everything fails". Strictly worse.
#
# The right place for this truth is metrics, not a probe. src/metrics.ts already
# exports tldraw_active_rooms, tldraw_room_lock_lost_total and the handover
# counters; scrape /metrics with the Ops Agent and alert on those.
#
# Redis being unreachable at *startup* is caught for free, by accident: the
# process exits (roomManager.ts) and systemd restart-loops with the port closed,
# so both checks fail for the honest reason.

# Fast, so a genuinely dead nginx VM drains quickly.
resource "google_compute_health_check" "nginx_lb" {
  name                = "tldraw-sync-gce-nginx-lb-hc"
  check_interval_sec  = 5
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3

  http_health_check {
    port         = 80
    request_path = "/nginx-health"
  }
}

# Slow and forgiving, because failing this one destroys a VM.
resource "google_compute_health_check" "nginx_autoheal" {
  name                = "tldraw-sync-gce-nginx-autoheal-hc"
  check_interval_sec  = 30
  timeout_sec         = 10
  healthy_threshold   = 1
  unhealthy_threshold = 6 # ~3 minutes of sustained failure

  http_health_check {
    port         = 80
    request_path = "/nginx-health"
  }
}

resource "google_dns_managed_zone" "public-zone" {
  project  = var.project_id
  for_each = { for z in var.public_zones : z.name => z }
  name     = each.value.name
  dns_name = each.value.dns_name
}

resource "google_dns_managed_zone" "private-zone" {
  project  = var.project_id
  for_each = { for z in var.private_zones : z.name => z }
  name     = each.value.name
  dns_name = each.value.dns_name

  visibility = "private"

  private_visibility_config {

    networks {
      network_url = google_compute_network.vpc_network.self_link
    }

  }
}
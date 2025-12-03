# VPC network
output "vpc_network" {
  description = "The VPC network resource"
  value       = google_compute_network.vpc_network
}
# Router 
output "router" {
  description = "The router used for NAT"
  value       = google_compute_router.router
}
# subnets
output "subnets" {
  value = google_compute_subnetwork.subnets
}
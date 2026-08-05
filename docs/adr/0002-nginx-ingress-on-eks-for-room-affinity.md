# The AWS demo targets ingress-nginx on EKS, not ALB or Fargate

Room Affinity requires consistent hashing on the request path, because every Session of one Room must reach that Room's Owner. The GCP demo gets this from ingress-nginx's `upstream-hash-by: "$uri"`, and the AWS demo will do the same: ingress-nginx on EKS behind an NLB. The AWS-native options do not provide the property we need — ALB offers round-robin or per-client cookie stickiness, which pins an individual browser to a target but scatters different Sessions of the same Room across pods; NLB hashes on the 5-tuple, which is per-connection, not per-Room. ECS Fargate behind an ALB has the same routing limitation with none of the k8s overhead saved elsewhere.

## Consequences

The AWS demo carries a self-managed ingress controller, which a reader expecting an AWS-native stack will find surprising — hence this record. The system is _correct_ without Room Affinity (the Room Lock is what establishes ownership), so a future ALB-based variant would still work; it would simply make Handover the steady state instead of the exception, and the demo's scaling story would be dominated by handover churn.

Related: ElastiCache must run with **cluster mode disabled**. The four Redis connections in `roomManager.ts` use plain `createClient()` and global-channel pub/sub; cluster mode would require `createCluster()` and sharded pub/sub — a code change, not a config change.

import * as k8s from "@kubernetes/client-node";
import { setHeaderOptions } from "@kubernetes/client-node";

const DELETION_COST_ANNOTATION = "controller.kubernetes.io/pod-deletion-cost";
const COST_PER_ROOM = 1000;
const UPDATE_INTERVAL_MS = 30_000;

const POD_NAME = process.env.POD_NAME;
const POD_NAMESPACE = process.env.POD_NAMESPACE || "default";

let k8sApi: k8s.CoreV1Api | null = null;
let updateInterval: NodeJS.Timeout | null = null;
let lastKnownCost: number | null = null;

function initializeK8sClient(): boolean {
  if (!POD_NAME) {
    console.log(
      "[PodAnnotator] POD_NAME not set. Skipping K8s annotation updates (local dev mode)."
    );
    return false;
  }

  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    k8sApi = kc.makeApiClient(k8s.CoreV1Api);
    console.log(
      `[PodAnnotator] Initialized. Will update annotations for pod: ${POD_NAME} in namespace: ${POD_NAMESPACE}`
    );
    return true;
  } catch (err) {
    console.error("[PodAnnotator] Failed to initialize K8s client:", err);
    return false;
  }
}

async function updateDeletionCost(activeRoomCount: number): Promise<void> {
  if (!k8sApi || !POD_NAME) return;

  const newCost = activeRoomCount * COST_PER_ROOM;

  if (lastKnownCost === newCost) return;

  const patchBody = {
    metadata: {
      annotations: {
        [DELETION_COST_ANNOTATION]: String(newCost),
      },
    },
  };

  const options = setHeaderOptions("Content-Type", "application/merge-patch+json");

  try {
    await k8sApi.patchNamespacedPod(
      { name: POD_NAME, namespace: POD_NAMESPACE, body: patchBody },
      options
    );

    lastKnownCost = newCost;
    console.log(
      `[PodAnnotator] Updated pod-deletion-cost to ${newCost} (${activeRoomCount} active rooms)`
    );
  } catch (err) {
    console.error("[PodAnnotator] Failed to update pod annotation:", err);
  }
}

/**
 * Starts periodic annotation updates based on active room count.
 * @param getActiveRoomCount - Function that returns current number of active rooms
 */
export function startPodAnnotator(getActiveRoomCount: () => number): void {
  if (!initializeK8sClient()) return;

  updateDeletionCost(getActiveRoomCount());

  updateInterval = setInterval(() => {
    updateDeletionCost(getActiveRoomCount());
  }, UPDATE_INTERVAL_MS);

  console.log(
    `[PodAnnotator] Started. Updating every ${UPDATE_INTERVAL_MS / 1000}s.`
  );
}

/**
 * Stops the annotator and sets deletion cost to 0 (ready for termination).
 */
export async function stopPodAnnotator(): Promise<void> {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }

  if (k8sApi && POD_NAME) {
    const patchBody = {
      metadata: {
        annotations: {
          [DELETION_COST_ANNOTATION]: "0",
        },
      },
    };

    const options = setHeaderOptions("Content-Type", "application/merge-patch+json");

    try {
      await k8sApi.patchNamespacedPod(
        { name: POD_NAME, namespace: POD_NAMESPACE, body: patchBody },
        options
      );
      console.log("[PodAnnotator] Set pod-deletion-cost to 0 (draining).");
    } catch (err) {
      console.error("[PodAnnotator] Failed to reset pod annotation:", err);
    }
  }

  console.log("[PodAnnotator] Stopped.");
}

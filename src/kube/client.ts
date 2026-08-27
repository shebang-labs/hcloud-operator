/**
 * Creates the Kubernetes clients.
 *
 * Two situations:
 *
 * 1. Inside a Pod: `loadFromCluster()` reads the ServiceAccount token and the
 *    cluster CA that Kubernetes mounts automatically into every Pod at
 *    /var/run/secrets/kubernetes.io/serviceaccount. No kubeconfig needed.
 * 2. On a laptop: `loadFromDefault()` uses ~/.kube/config, exactly like kubectl.
 *
 * We detect case 1 by the KUBERNETES_SERVICE_HOST variable, which the API server
 * injects into every Pod.
 */

import {
    CoordinationV1Api,
    CoreV1Api,
    CustomObjectsApi,
    KubeConfig,
} from '@kubernetes/client-node';
import type { Logger } from '../observability/logger.js';

export interface KubernetesClients {
    kubeConfig: KubeConfig;
    /** Custom resources: everything this operator owns. */
    customObjects: CustomObjectsApi;
    /** Leases, for leader election. */
    coordination: CoordinationV1Api;
    /** Secrets (certificate private keys) and Events. */
    core: CoreV1Api;
    /** True when running inside a cluster (in-cluster ServiceAccount auth). */
    inCluster: boolean;
}

export function createKubernetesClients(
    logger: Logger,
    env: NodeJS.ProcessEnv = process.env,
): KubernetesClients {
    const kubeConfig = new KubeConfig();
    const inCluster = Boolean(env.KUBERNETES_SERVICE_HOST);

    if (inCluster) {
        kubeConfig.loadFromCluster();
        logger.info('Using in-cluster Kubernetes credentials (ServiceAccount)');
    } else {
        kubeConfig.loadFromDefault();
        logger.info('Using local kubeconfig', { context: kubeConfig.getCurrentContext() });
    }

    return {
        kubeConfig,
        customObjects: kubeConfig.makeApiClient(CustomObjectsApi),
        coordination: kubeConfig.makeApiClient(CoordinationV1Api),
        core: kubeConfig.makeApiClient(CoreV1Api),
        inCluster,
    };
}

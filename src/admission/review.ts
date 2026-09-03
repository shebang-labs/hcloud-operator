/**
 * The `admission.k8s.io/v1` request and response shapes.
 *
 * Only the fields the operator reads are declared. The API server sends a great
 * deal more, and typing all of it would be a maintenance burden for no benefit.
 */

export interface AdmissionRequest {
    uid: string;
    kind?: { group?: string; version?: string; kind?: string };
    resource?: { group?: string; version?: string; resource?: string };
    namespace?: string;
    name?: string;
    operation?: 'CREATE' | 'UPDATE' | 'DELETE' | 'CONNECT';
    object?: { metadata?: { name?: string; namespace?: string }; spec?: unknown } | null;
    oldObject?: { spec?: unknown } | null;
}

export interface AdmissionReview {
    apiVersion?: string;
    kind?: string;
    request?: AdmissionRequest;
}

export interface AdmissionResponse {
    uid: string;
    allowed: boolean;
    status?: { code: number; message: string };
    /** Shown by kubectl but does not block the request. */
    warnings?: string[];
}

export function allow(uid: string, warnings: string[] = []): AdmissionResponse {
    return { uid, allowed: true, ...(warnings.length ? { warnings } : {}) };
}

export function deny(uid: string, message: string): AdmissionResponse {
    // 422 Unprocessable Entity is what kubectl renders most usefully: the
    // message appears verbatim next to the rejected object.
    return { uid, allowed: false, status: { code: 422, message } };
}

/** Wraps a response in the envelope the API server expects back. */
export function toReview(response: AdmissionResponse): Record<string, unknown> {
    return {
        apiVersion: 'admission.k8s.io/v1',
        kind: 'AdmissionReview',
        response,
    };
}

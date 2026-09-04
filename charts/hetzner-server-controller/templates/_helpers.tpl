{{/*
Chart name, overridable.
*/}}
{{- define "hetzner-server-controller.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name. If the release name contains the chart name it is
used as-is, so `helm install hetzner-server-controller ...` gives short names.
*/}}
{{- define "hetzner-server-controller.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "hetzner-server-controller.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "hetzner-server-controller.labels" -}}
helm.sh/chart: {{ include "hetzner-server-controller.chart" . }}
{{ include "hetzner-server-controller.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "hetzner-server-controller.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hetzner-server-controller.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "hetzner-server-controller.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "hetzner-server-controller.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The Secret and key the token is read from: the user's own Secret when given,
otherwise the one this chart creates.
*/}}
{{- define "hetzner-server-controller.tokenSecretName" -}}
{{- if .Values.hetzner.existingSecret }}
{{- .Values.hetzner.existingSecret }}
{{- else }}
{{- include "hetzner-server-controller.fullname" . }}
{{- end }}
{{- end }}

{{- define "hetzner-server-controller.tokenSecretKey" -}}
{{- if .Values.hetzner.existingSecret }}
{{- .Values.hetzner.existingSecretKey }}
{{- else }}
{{- "token" }}
{{- end }}
{{- end }}

{{/*
Fail early, with an explanation, when there is no way to obtain a token. A
Deployment that crash-loops on a missing environment variable is a far worse
way to learn this.
*/}}
{{- define "hetzner-server-controller.validateToken" -}}
{{- if and (not .Values.hetzner.token) (not .Values.hetzner.existingSecret) }}
{{- fail "\n\nA Hetzner Cloud API token is required. Either:\n\n  --set hetzner.token=<token>\n\nor point the chart at a Secret you manage:\n\n  --set hetzner.existingSecret=<secret-name> [--set hetzner.existingSecretKey=token]\n\nCreate the token in the Hetzner Cloud Console under Security -> API tokens, with Read & Write permission.\n" }}
{{- end }}
{{- if and (not .Values.leaderElection.enabled) (gt (int .Values.replicaCount) 1) }}
{{- fail "leaderElection.enabled=false is only safe with replicaCount=1: two replicas without a lease would both act on the same objects." }}
{{- end }}
{{- end }}

{{- define "hetzner-server-controller.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag }}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}
{{- end }}

{{- define "hetzner-server-controller.webhookServiceName" -}}
{{- printf "%s-webhook" (include "hetzner-server-controller.fullname" .) }}
{{- end }}

{{- define "hetzner-server-controller.webhookCertificateName" -}}
{{- printf "%s-webhook" (include "hetzner-server-controller.fullname" .) }}
{{- end }}

{{- define "hetzner-server-controller.webhookSecretName" -}}
{{- printf "%s-webhook-tls" (include "hetzner-server-controller.fullname" .) }}
{{- end }}

{{/*
Every plural the controller serves. Kept in one place so RBAC and the
webhook can never disagree about the list.
*/}}
{{- define "hetzner-server-controller.plurals" -}}
- hetznerservers
- hetznersshkeys
- hetznervolumes
- hetznernetworks
- hetznerfirewalls
- hetznerloadbalancers
- hetznerfloatingips
- hetznerprimaryips
- hetznerplacementgroups
- hetznercertificates
- hetznerimages
{{- end }}

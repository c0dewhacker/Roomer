{{/*
Expand the name of the chart.
*/}}
{{- define "roomer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "roomer.fullname" -}}
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

{{- define "roomer.api.fullname" -}}
{{- printf "%s-api" (include "roomer.fullname" .) }}
{{- end }}

{{- define "roomer.web.fullname" -}}
{{- printf "%s-web" (include "roomer.fullname" .) }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "roomer.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "roomer.labels" -}}
helm.sh/chart: {{ include "roomer.chart" . }}
{{ include "roomer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — used by both api and web; callers pass a component suffix.
*/}}
{{- define "roomer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "roomer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "roomer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "roomer.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name — supports bring-your-own secret.
*/}}
{{- define "roomer.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-secret" (include "roomer.fullname" .) }}
{{- end }}
{{- end }}

{{/*
ConfigMap name.
*/}}
{{- define "roomer.configMapName" -}}
{{- printf "%s-config" (include "roomer.fullname" .) }}
{{- end }}

{{/*
Database URL — resolved in priority order:
  1. postgresql.enabled=true  → auto-constructed from sub-chart auth values
  2. secrets.databaseUrl set  → used as-is (full connection string override)
  3. config.dbHost set        → assembled from config.db* + secrets.dbPassword
*/}}
{{- define "roomer.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgresql://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "roomer.fullname" .) .Values.postgresql.auth.database }}
{{- else if .Values.secrets.databaseUrl }}
{{- .Values.secrets.databaseUrl }}
{{- else if .Values.config.dbHost }}
{{- $base := printf "postgresql://%s:%s@%s:%s/%s"
      (required "config.dbUser is required when using config.dbHost" .Values.config.dbUser)
      (required "secrets.dbPassword is required when using config.dbHost" .Values.secrets.dbPassword)
      .Values.config.dbHost
      .Values.config.dbPort
      (required "config.dbName is required when using config.dbHost" .Values.config.dbName) -}}
{{- if .Values.config.dbSslMode -}}
{{- printf "%s?sslmode=%s" $base .Values.config.dbSslMode }}
{{- else -}}
{{- $base }}
{{- end }}
{{- else }}
{{- fail "Database not configured: set postgresql.enabled=true, secrets.databaseUrl, or config.dbHost + secrets.dbPassword" }}
{{- end }}
{{- end }}

{{/*
API image reference. Falls back to Chart.appVersion if tag is explicitly cleared.
*/}}
{{- define "roomer.api.image" -}}
{{- printf "%s:%s" .Values.api.image.repository (.Values.api.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{/*
Web image reference. Falls back to Chart.appVersion if tag is explicitly cleared.
*/}}
{{- define "roomer.web.image" -}}
{{- printf "%s:%s" .Values.web.image.repository (.Values.web.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{/*
Bundled PostgreSQL (official postgres image).
Every new setting reads through `dig` with a default: an upgrade from chart
0.1.x with --reuse-values carries the old Bitnami sub-chart's computed values
(postgresql.image, postgresql.primary, ...) and none of this chart's new defaults.
*/}}

{{/* Service name — unchanged from the Bitnami sub-chart so DATABASE_URL and existing clients keep working. */}}
{{- define "roomer.postgresql.serviceName" -}}
{{- printf "%s-postgresql" (include "roomer.fullname" .) }}
{{- end }}

{{/* StatefulSet name — deliberately different from the Bitnami one, whose volumeClaimTemplates are immutable. */}}
{{- define "roomer.postgresql.statefulsetName" -}}
{{- printf "%s-postgres" (include "roomer.fullname" .) }}
{{- end }}

{{/* PVC created by the StatefulSet's `data` volumeClaimTemplate for pod 0. */}}
{{- define "roomer.postgresql.dataClaimName" -}}
{{- printf "data-%s-0" (include "roomer.postgresql.statefulsetName" .) }}
{{- end }}

{{/*
Name the chart 0.1.x Bitnami sub-chart gave its StatefulSet, Service and Secret
(its own `common.names.fullname`, evaluated in the sub-chart's scope).
*/}}
{{- define "roomer.postgresql.legacyName" -}}
{{- $sub := .Values.postgresql }}
{{- if $sub.fullnameOverride }}
{{- $sub.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default "postgresql" $sub.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "roomer.postgresql.secretName" -}}
{{- printf "%s-postgres-auth" (include "roomer.fullname" .) }}
{{- end }}

{{- define "roomer.postgresql.image" -}}
{{- $img := dig "server" "image" dict .Values.postgresql }}
{{- printf "%s:%s" ($img.repository | default "postgres") (toString ($img.tag | default "18")) }}
{{- end }}

{{- define "roomer.postgresql.selectorLabels" -}}
{{ include "roomer.selectorLabels" . }}
app.kubernetes.io/component: postgresql
{{- end }}

{{- define "roomer.postgresql.persistenceSize" -}}
{{- dig "primary" "persistence" "size" "10Gi" .Values.postgresql }}
{{- end }}

{{- define "roomer.postgresql.storageClass" -}}
{{- dig "primary" "persistence" "storageClass" "" .Values.postgresql }}
{{- end }}

{{/*
"true" when this upgrade must migrate data out of the chart 0.1.x Bitnami
StatefulSet: it still exists and the new StatefulSet does not. `lookup` returns
nothing under `helm template` / client dry-run, so the hook only renders against
a live cluster.
*/}}
{{- define "roomer.postgresql.needsMigration" -}}
{{- if and .Values.postgresql.enabled (dig "migration" "enabled" true .Values.postgresql) -}}
{{- $old := lookup "apps/v1" "StatefulSet" .Release.Namespace (include "roomer.postgresql.legacyName" .) -}}
{{- $new := lookup "apps/v1" "StatefulSet" .Release.Namespace (include "roomer.postgresql.statefulsetName" .) -}}
{{- if and $old (not $new) -}}
{{- $image := "" -}}
{{- range $old.spec.template.spec.containers -}}{{- $image = printf "%s %s" $image .image -}}{{- end -}}
{{- if contains "bitnami" $image -}}true{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
File storage backend: "local" or "s3". Older values files have no `storage` key.
*/}}
{{- define "roomer.storageBackend" -}}
{{- $backend := dig "backend" "local" (.Values.storage | default dict) -}}
{{- if not (has $backend (list "local" "s3")) -}}
{{- fail (printf "storage.backend must be \"local\" or \"s3\", got %q" $backend) -}}
{{- end -}}
{{- $backend -}}
{{- end }}

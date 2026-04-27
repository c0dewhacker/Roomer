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
Database URL — auto-constructed when postgresql sub-chart is enabled.
*/}}
{{- define "roomer.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgresql://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "roomer.fullname" .) .Values.postgresql.auth.database }}
{{- else }}
{{- required "secrets.databaseUrl is required when postgresql.enabled is false" .Values.secrets.databaseUrl }}
{{- end }}
{{- end }}

{{/*
API image reference.
*/}}
{{- define "roomer.api.image" -}}
{{- printf "%s:%s" .Values.api.image.repository (.Values.api.image.tag | default .Chart.AppVersion) }}
{{- end }}

{{/*
Web image reference.
*/}}
{{- define "roomer.web.image" -}}
{{- printf "%s:%s" .Values.web.image.repository (.Values.web.image.tag | default .Chart.AppVersion) }}
{{- end }}

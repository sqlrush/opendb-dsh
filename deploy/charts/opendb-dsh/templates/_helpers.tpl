{{- define "opendb.name" -}}{{ .Chart.Name }}{{- end -}}
{{- define "opendb.labels" -}}
app.kubernetes.io/name: {{ include "opendb.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "opendb.pgUrl" -}}
{{- if .Values.postgres.builtin -}}
postgres://{{ .Values.postgres.user }}:{{ .Values.postgres.password }}@{{ .Release.Name }}-postgres:5432/{{ .Values.postgres.database }}
{{- else -}}
{{ .Values.postgres.externalUrl }}
{{- end -}}
{{- end -}}
{{- define "opendb.s3Endpoint" -}}http://{{ .Release.Name }}-minio:9000{{- end -}}
{{- define "opendb.trustedHosts" -}}
{{- $hosts := list -}}
{{- if .Values.ingress.enabled }}{{ $hosts = append $hosts .Values.ingress.host }}{{ end -}}
{{- $hosts = append $hosts (printf "%s-host:%d" .Release.Name (int .Values.host.port)) -}}
{{- $hosts = append $hosts (printf "%s-host.%s.svc:%d" .Release.Name .Release.Namespace (int .Values.host.port)) -}}
{{- $hosts = append $hosts (printf "%s-host.%s.svc.cluster.local:%d" .Release.Name .Release.Namespace (int .Values.host.port)) -}}
{{- range .Values.host.extraTrustedHosts }}{{ $hosts = append $hosts . }}{{ end -}}
{{ join "," $hosts }}
{{- end -}}
{{- define "opendb.commonEnv" -}}
- name: OPENDB_PG_URL
  value: {{ include "opendb.pgUrl" . | quote }}
- name: OPENDB_S3_ENDPOINT
  value: {{ include "opendb.s3Endpoint" . | quote }}
- name: OPENDB_S3_BUCKET
  value: {{ .Values.minio.bucket | quote }}
- name: OPENDB_S3_ACCESS_KEY
  value: {{ .Values.minio.rootUser | quote }}
- name: OPENDB_S3_SECRET_KEY
  value: {{ .Values.minio.rootPassword | quote }}
- name: DEEPSEEK_API_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.llm.existingSecret }}, key: DEEPSEEK_API_KEY } }
{{- if .Values.llm.deepseekBaseUrl }}
- name: DEEPSEEK_BASE_URL
  value: {{ .Values.llm.deepseekBaseUrl | quote }}
{{- end }}
- name: DSH_TELEMETRY_DISABLED
  value: "1"
- name: DSH_PERMISSION_MODE
  value: read-only
{{- end -}}
{{- define "opendb.waitForPg" -}}
- name: wait-for-pg
  image: busybox:1.36
  command: ["sh", "-c", "until nc -z {{ .Release.Name }}-postgres 5432; do echo waiting for postgres; sleep 2; done"]
{{- end -}}
